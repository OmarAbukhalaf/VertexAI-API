
const express = require('express');
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
const admin = require('firebase-admin');
const app = express();
const NodeCache = require('node-cache');
const promptCache = new NodeCache({ stdTTL: 3600 });
const PORT = 3000;
const path = require('path');
const multer = require('multer');
const { Storage } = require('@google-cloud/storage');
const cors = require('cors');
app.use(cors({ origin: '*' })); 
app.use(express.json());





// === Firebase Admin Initialization from ENV ===
const firebaseBase64 = process.env.FIREBASE_CREDENTIALS_BASE64;
const firebaseServiceAccount = JSON.parse(
  Buffer.from(firebaseBase64, 'base64').toString('utf8')
);

admin.initializeApp({
  credential: admin.credential.cert(firebaseServiceAccount),
});
const db = admin.firestore();


const upload = multer({ storage: multer.memoryStorage() });

// === Dialogflow Auth from ENV ===
async function getAccessToken() {
  const dialogflowBase64 = process.env.DIALOGFLOW_CREDENTIALS_BASE64;
  const dialogflowCredentials = JSON.parse(
    Buffer.from(dialogflowBase64, 'base64').toString('utf8')
  );

  const auth = new GoogleAuth({
    credentials: dialogflowCredentials,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

const storage = new Storage({
  credentials: dialogflowCredentials,
});


// === Get Advertiser Data ===
async function getAdvertiserData(advertiserId) {
  // ✅ Return prompt from cache if available
  const cachedData = promptCache.get(advertiserId);
  if (cachedData) {
    console.log('Prompt fetched from cache');
    return cachedData; // { prompt: string, timestamp: Date }
  }

  const doc = await db.collection('advertiser_settings').doc(advertiserId).get();
  if (!doc.exists) {
    return { prompt: '', timestamp: null };
  }
  

  const data = doc.data();
  const customVocab = data.ADV_custom_vocab;
  const tone = data.ADV_language_style;
  const banned_phrases=data.ADV_banned_phrases;
  const trigger_condition =data.ADV_trigger_condition;
  const trigger_delay=data.ADV_trigger_delay;
  const trigger_message=data.ADV_trigger_message;
  const idle_timeout_msg=data.ADV_idle_timeout_msg;
  const fallback_message=data.ADV_fallback_message;
  const ai_instructions=data.ADV_ai_instructions;

  const missingfields=!customVocab || !tone||!banned_phrases||!trigger_condition||!trigger_delay||!trigger_message||!idle_timeout_msg||!fallback_message||!ai_instructions;
  // ✅ Generate prompt dynamically
  const generatedPrompt = `${ai_instructions || "You are a customer support assistant."}
Always follow the brand's support style. Be conversational, clear, and helpful. Never mention that you are an AI.

Custom Vocabulary: Use brand-specific terms when applicable.
Example: ${customVocab || ""}

Behavior Rules:
Tone: ${tone || "friendly and professional"}

❗ Banned Phrases:
Never use or repeat the following: ${banned_phrases || "[none specified]"}

🔁 Unclear Input:
If the user’s message is confusing or unclear, reply with:
"I didn’t quite catch that. Could you try rephrasing?"

🕒 Idle Timeout Trigger:
If no user input is received and the condition ${trigger_condition || "user_idle_for_30s"} is met after ${trigger_delay || 5000}ms, initiate:
"${trigger_message || 'Hi there! Need help with anything?'}"

⌛ Idle Timeout Message:
If the user has been inactive for an extended period, send:
"${idle_timeout_msg || 'Still there? Let me know if you need anything!'}"

⚠️ Fallback Handling:
If no suitable response or intent is found, use the fallback message:
"${fallback_message || 'I’m here to help, but I might need a bit more info to assist you.'}"

Style Guide:
Apply custom vocabulary and adhere to tone and language style across all replies.`;

  const promptObj = { prompt: generatedPrompt, timestamp: new Date(), missingfields };
  promptCache.set(advertiserId, promptObj);
  console.log('Prompt generated and cached');
  return promptObj;
}


// === Detect Intent ===
async function detectIntent({ projectId, locationId, agentId, sessionId, message,advertiserName, advertiserData = {} }) {
  const accessToken = await getAccessToken();

  const url = `https://${locationId}-dialogflow.googleapis.com/v3/projects/${projectId}/locations/${locationId}/agents/${agentId}/sessions/${sessionId}:detectIntent`;

  // 🧠 Prompt with advertiser data
  const prompt = advertiserData.Prompt;
  const missingFields = advertiserData.missingfields;



  const finalMessage = `${prompt}\n\nAdvertiser:${advertiserName}\n\n Query:${message}`;

  const payload = {
    queryInput: {
      text: { text: finalMessage },
      languageCode: 'en-US',
    },
    queryParams: {
      parameters: {}
    }
  };

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  const result = response.data.queryResult;
  
  const result_text=result.responseMessages?.[0]?.text?.text?.[0] || 'No response from agent.';
  return missingFields ? `Missing Fields: ${result_text}` : result_text;

}

// === Express POST /chat Endpoint ===
app.post('/chat', async (req, res) => {
  try {
    const {
      message,
      advertiserName,
      advertiserId,
      sessionId = 'default-session'
    } = req.body;

    if (!message || !advertiserId) {
      return res.status(400).json({ error: 'Missing message or advertiserId' });
    }

    const advertiserData = await getAdvertiserData(advertiserId);

    const response = await detectIntent({
      projectId: 'aichat-457808',
      locationId: 'us-central1',
      agentId: '901d59b6-589f-431c-8be3-daca6f6766a7',
      sessionId,
      message,
      advertiserName,
      advertiserData
    });

    res.json({ response });
    console.log("Response:", response)
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to contact Gemini agent' });
  }
});

// Route: Upload multiple files + advertiserName
app.post('/upload', upload.array('files'), async (req, res) => {
  const advertiserName = req.body.advertiserName;
  const files = req.files;
  console.log(files)
  if (!advertiserName) return res.status(400).send('Missing advertiserName');
  if (!files || files.length === 0) return res.status(400).send('No files uploaded');

  try {
    const bucketName = advertiserName.toLowerCase().replace(/\s+/g, '-');

    // Check if bucket exists
    const [buckets] = await storage.getBuckets();
    let bucket = buckets.find(b => b.name === bucketName);

    if (!bucket) {
      console.log(`Creating new bucket: ${bucketName}`);
      [bucket] = await storage.createBucket(bucketName, {
        location: 'US',
        storageClass: 'STANDARD',
      });
    }

    const uploadedFiles = [];

    for (const file of files) {
      const blob = bucket.file(file.originalname);
      const blobStream = blob.createWriteStream({
        resumable: false,
        contentType: file.mimetype,
      });

      await new Promise((resolve, reject) => {
        blobStream.on('error', reject);
        blobStream.on('finish', resolve);
        blobStream.end(file.buffer);
      });

      // Optional: Make public
      // await blob.makePublic();
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
      uploadedFiles.push({ fileName: file.originalname, url: publicUrl });
    }

    res.status(200).json({
      message: `Uploaded ${uploadedFiles.length} file(s) to bucket "${bucket.name}"`,
      files: uploadedFiles,
    });

  } catch (err) {
    console.error('Upload failed:', err);
    res.status(500).send('Internal Server Error');
  }
});


app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
