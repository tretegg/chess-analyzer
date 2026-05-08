// src/routes/api/explain/+server.ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';

const genAI = new GoogleGenerativeAI(env.VITE_GEMINI_API_KEY || "");

export async function POST({ request }) {
    try {
        const { fen, movePlayed, recentMoves, evalChange, engineLine } = await request.json();

        const prompt = `
            You are a helpful chess coach analyzing a student's move.
            
            Current Board (FEN): ${fen}
            Previous few moves: ${recentMoves}
            The student just played: ${movePlayed}
            The engine evaluation changed by: ${evalChange} pawns.
            The engine says the best continuation is: ${engineLine}

            Your ONLY job is to explain the quality of the student's move (${movePlayed}). 
            
            Rules:
            1. If the evaluation dropped significantly (a blunder or mistake), explain exactly why it was a bad idea and what tactic they missed.
            2. If the move is good, brilliant, or matches the engine, explain WHY it is a strong move (e.g., "Great job pinning the knight," or "This perfectly controls the center and prepares an attack").
            3. Focus purely on the chess logic. DO NOT mention evaluation numbers, pawn drops, or centipawns.
            4. Keep it to 1 or 2 simple, conversational sentences.
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