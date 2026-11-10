import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
app.use(express.json());

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. Meta Webhook Verification Handshake
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified by Meta!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2. Incoming Messenger Messages Handler
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry) {
      const pageId = entry.id;
      const webhookEvent = entry.messaging?.[0];

      if (!webhookEvent || !webhookEvent.message || webhookEvent.message.is_echo) {
        continue;
      }

      const senderPsid = webhookEvent.sender.id;
      const userMessage = webhookEvent.message.text || '';

      if (!userMessage) continue;

      try {
        await handleCustomerMessage(pageId, senderPsid, userMessage);
      } catch (err) {
        console.error('Error handling customer message:', err.message);
      }
    }
  } else {
    res.sendStatus(404);
  }
});

// 3. Process Customer Query with Supabase & Gemini
async function handleCustomerMessage(pageId, senderPsid, userMessage) {
  const { data: merchant, error: merchantErr } = await supabase
    .from('merchants')
    .select('id, store_name, page_access_token')
    .eq('page_id', pageId)
    .single();

  if (merchantErr || !merchant || !merchant.page_access_token) {
    console.warn(`No active merchant found for Page ID: ${pageId}`);
    return;
  }

  const { data: products } = await supabase
    .from('products')
    .select('title, price, description, in_stock')
    .eq('merchant_id', merchant.id)
    .eq('in_stock', true);

  const productCatalog = (products || [])
    .map((p) => `- ${p.title}: ৳${p.price} (${p.description || 'No description'})`)
    .join('\n');

  const systemPrompt = `
You are the polite, helpful AI sales assistant for the Facebook page "${merchant.store_name}".
Respond warmly in polite, natural Bengali/Banglish (conversational e-commerce style in Bangladesh).

AVAILABLE PRODUCTS IN STORE:
${productCatalog || 'No products listed yet.'}

YOUR GOALS:
1. Answer customer questions about products, prices, and stock using only the catalog above.
2. If the customer wants to order, ask for their:
   - Name
   - Phone Number (01...)
   - Full Delivery Address
3. When they provide Name, Phone, and Address, confirm the Cash on Delivery order and include an internal JSON payload at the very end:
<<<ORDER_JSON
{
  "customer_name": "...",
  "customer_phone": "...",
  "customer_address": "...",
  "product_details": "...",
  "total_amount": 0
}
ORDER_JSON>>>
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      { role: 'user', parts: [{ text: `${systemPrompt}\n\nCustomer: ${userMessage}` }] }
    ]
  });

  const replyText = response.text || 'ধন্যবাদ! আমরা খুব শীঘ্রই উত্তর দিচ্ছি।';

  let cleanReply = replyText;
  const orderMatch = replyText.match(/<<<ORDER_JSON([\s\S]*?)ORDER_JSON>>>/);

  if (orderMatch && orderMatch[1]) {
    try {
      const orderData = JSON.parse(orderMatch[1].trim());
      await supabase.from('orders').insert([
        {
          merchant_id: merchant.id,
          customer_name: orderData.customer_name || 'Customer',
          customer_phone: orderData.customer_phone || 'N/A',
          customer_address: orderData.customer_address || 'N/A',
          product_details: orderData.product_details || 'Catalog Item',
          total_amount: Number(orderData.total_amount) || 0,
          payment_method: 'Cash on Delivery',
          order_status: 'Pending'
        }
      ]);
      cleanReply = replyText.replace(/<<<ORDER_JSON[\s\S]*?ORDER_JSON>>>/, '').trim();
    } catch (parseErr) {
      console.error('Failed to parse order JSON:', parseErr.message);
    }
  }

  await sendMessengerReply(merchant.page_access_token, senderPsid, cleanReply);
}

// 4. Send Message via Meta Graph API
async function sendMessengerReply(pageAccessToken, recipientPsid, messageText) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${pageAccessToken}`;
  await axios.post(url, {
    recipient: { id: recipientPsid },
    message: { text: messageText }
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Shohayok AI webhook server running on port ${PORT}`);
});
