// src/routes/api/explain/+server.ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';

const genAI = new GoogleGenerativeAI(env.VITE_GEMINI_API_KEY || "");

export async function POST({ request }) {
    try {
        const { fen, move, evalChange, bestMove } = await request.json();

        // Updated for concise, punchy feedback
        const prompt = `
            You are a sharp, direct chess grandmaster.
            Current FEN: ${fen}
            Player moved: ${move}
            Eval changed by: ${evalChange} pawns.
            Engine prefers: ${bestMove}

            Provide a 1-sentence, punchy explanation of why this move is good or bad. 
            Do NOT use conversational filler. Be direct and concise.
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(prompt);
        const explanation = result.response.text();

        return json({ explanation });
    } catch (error) {
        console.error("Gemini Error:", error);
        return json({ explanation: "API Error: Unable to fetch coaching." }, { status: 500 });
    }
}