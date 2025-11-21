import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import { setupSocketHandlers } from "./sockets/handlers";

dotenv.config();

const app = express();
const httpServer = createServer(app);

// CORS configuration for Next.js frontend
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/health", (req: express.Request, res: express.Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);
  setupSocketHandlers(socket, io);
});

const PORT = process.env.PORT || 4000;

httpServer.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
