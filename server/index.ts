import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import { setupSocketHandlers } from "./sockets/handlers";
import { setSocketIOInstance, audioProcessor } from "./audio/processor";

dotenv.config();

const app = express();
const httpServer = createServer(app);

// CORS configuration for Next.js frontend with low-latency optimizations
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket"], // Force websocket for lower latency
  pingTimeout: 60000,
  pingInterval: 25000,
  allowEIO3: true,
});

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/health", (req: express.Request, res: express.Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Set socket.io instance for audio processor
setSocketIOInstance(io);

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);
  setupSocketHandlers(socket, io);
});

const PORT = process.env.PORT || 4000;

httpServer.listen(PORT, async () => {
  console.log(`WebSocket server running on port ${PORT}`);
  
  // Resume interrupted sessions on startup (crash recovery)
  await audioProcessor.resumeInterruptedSessions().catch(console.error);
  
  // Clean up old audio files on startup and then every 24 hours
  await audioProcessor.cleanupOldAudioFiles().catch(console.error);
  
  // Schedule periodic cleanup (every 24 hours)
  setInterval(() => {
    audioProcessor.cleanupOldAudioFiles().catch(console.error);
  }, 24 * 60 * 60 * 1000);
});
