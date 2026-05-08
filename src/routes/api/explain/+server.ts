// src/routes/api/explain/+server.ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';

const genAI = new GoogleGenerativeAI(env.VITE_GEMINI_API_KEY || "");

export async function POST({ request }) {
    try {
        const { fen, move, evalChange, bestMove } = await request.json();

        const prompt = `
            You are an elite, direct chess coach.
            Current board position (FEN): ${fen}
            The player just played: ${move}
            The engine's evaluation changed by: ${evalChange} pawns.
            The engine's mathematically proven best move was: ${bestMove}

            CRITICAL INSTRUCTIONS: 
            1. Treat the engine's best move as the absolute objective truth.
            2. DO NOT state the evaluation numbers. Never say things like "resulted in a 0.17 pawn evaluation drop".
            3. Explain the CHESS REASONING. Why is the engine's move (${bestMove}) positionally or tactically superior to the move played (${move})? 
            4. Keep it to exactly one punchy, insightful sentence. 
            5. Speak directly to the player (e.g., "While your move defends the pawn, Nc3 develops a piece and claims the center.").
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