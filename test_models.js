const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function run() {
  try {
    // List models is not directly available in Node SDK without hitting REST API, 
    // actually it might be. Let's just fetch it via REST.
  } catch (e) {
    console.error(e);
  }
}
run();
