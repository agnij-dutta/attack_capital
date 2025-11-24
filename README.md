# ScribeAI - AI-Powered Audio Transcription and Meeting Transcription App

A full-stack Next.js application for real-time audio transcription and meeting summarization using Google Gemini API. Capture audio from microphone or shared meeting tabs (Google Meet/Zoom), stream to Gemini for live transcription, and store sessions in Postgres.

## Features

- **Real-time Audio Transcription**: Capture audio from microphone or tab/screen share
- **Live Streaming**: Stream audio chunks to WebSocket server for processing
- **AI-Powered Transcription**: Uses Google Gemini API for accurate transcription with speaker diarization
- **Meeting Summarization**: Automatically generates summaries with key points, action items, and decisions
- **Session Management**: View, search, and export past sessions
- **Resilient Architecture**: Handles network drops, buffer overflows, and device interruptions
- **Long-duration Support**: Optimized for sessions up to 1+ hours with chunked processing
- **Signal-Aware Capture**: Each chunk carries audio energy telemetry so the server can ignore silent/empty data and track confidence
- **Deterministic Audio Pipes**: Chunks are persisted on disk, hashed, stitched via FFmpeg, and the final MP3 is saved for debugging

## Tech Stack

- **Frontend/Backend**: Next.js 14+ (App Router, TypeScript)
- **Database**: PostgreSQL via Prisma ORM
- **Authentication**: Better Auth
- **Real-time Communication**: Socket.io
- **AI Integration**: Google Gemini API
- **Styling**: Tailwind CSS with dark mode support

## Prerequisites

- Node.js 18+ and npm
- Docker and Docker Compose (for local Postgres)
- Google Gemini API key ([Get one here](https://ai.google.dev))
- **FFmpeg** (required for audio format conversion)

### Installing FFmpeg

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt update && sudo apt install ffmpeg
```

**Windows:**
Download from [FFmpeg website](https://ffmpeg.org/download.html) or use:
```bash
choco install ffmpeg
```

FFmpeg is required to convert WebM audio (from browser MediaRecorder) to MP3 format, which is supported by the Gemini API.

## Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd attack_capital
npm install
cd server && npm install && cd ..
```

### 2. Set Up Environment Variables

Create a `.env` file in the root directory:

```env
# Database
DATABASE_URL="postgresql://scribeai:scribeai_password@localhost:5432/scribeai_db?schema=public"

# Better Auth
BETTER_AUTH_SECRET="your-random-secret-key-here"
BETTER_AUTH_URL="http://localhost:3000"

# Gemini API
GEMINI_API_KEY="your-gemini-api-key-here"

# Audio Debugging
SAVE_MP3_DEBUG="true"

# WebSocket Server
WEBSOCKET_URL="http://localhost:4000"
FRONTEND_URL="http://localhost:3000"
```

### 3. Start Database

```bash
docker-compose up -d
```

### 4. Run Database Migrations

```bash
npm run prisma:generate
npm run prisma:migrate
```

### 5. Start Development Servers

```bash
npm run dev
```

This starts both:
- Next.js frontend on `http://localhost:3000`
- WebSocket server on `http://localhost:4000`

### 6. Access the Application

1. Open `http://localhost:3000`
2. Sign up for a new account
3. Start recording from the dashboard

## Project Structure

```
attack_capital/
├── app/                    # Next.js App Router pages
│   ├── api/               # API routes
│   │   ├── auth/          # Better Auth endpoints
│   │   └── sessions/      # Session management endpoints
│   ├── dashboard/         # Recording dashboard
│   ├── sessions/          # Session history and detail pages
│   └── sign-in/          # Authentication pages
├── components/            # React components
├── hooks/                 # Custom React hooks
│   └── useAudioRecorder.ts
├── lib/                   # Shared utilities
│   ├── auth.ts           # Better Auth configuration
│   ├── gemini.ts         # Gemini API client
│   └── prisma.ts         # Prisma client
├── server/                # Standalone WebSocket server
│   ├── audio/            # Audio processing logic
│   ├── sockets/          # Socket.io handlers
│   └── lib/              # Server utilities
├── prisma/               # Database schema and migrations
└── docker-compose.yml    # Postgres database setup
```

## Architecture

### System Flow

```mermaid
graph TB
    A[Browser Client] -->|MediaRecorder API| B[Audio Capture]
    B -->|WebSocket| C[Socket.io Server]
    C -->|Buffer Chunks| D[Audio Processor]
    D -->|Every 30s| E[Gemini API]
    E -->|Transcript| F[Postgres Database]
    D -->|On Stop| G[Generate Summary]
    G -->|Summary| F
    F -->|Query| H[Next.js API]
    H -->|Display| A
```

### Component Architecture

1. **Client Side (Next.js Frontend)**
   - `useAudioRecorder` hook manages MediaRecorder API
   - Supports microphone and tab/screen share audio capture
   - Streams audio chunks via Socket.io to WebSocket server
   - Real-time UI updates based on Socket.io events

2. **WebSocket Server (Node.js)**
   - Express + Socket.io server on port 4000
   - Receives audio chunks from clients
   - Buffers audio in memory (with disk persistence)
   - Chunks audio every 30 seconds for Gemini processing (as per PRD requirement)
   - Manages session state (recording, paused, processing, completed)

3. **Audio Processing**
   - Server-side buffering with 2GB max per session
   - Automatic chunking every 30 seconds (as per PRD requirement - provides better context for accurate transcription)
   - Converts audio to base64 for Gemini API
   - Handles stream interruptions and reconnections

4. **Gemini Integration**
   - Chunked transcription with speaker diarization
   - Post-processing summary generation
   - Error handling and retry logic

5. **Database (Postgres)**
   - User authentication (Better Auth)
   - RecordingSession model for session metadata
   - TranscriptChunk model for incremental transcripts
   - Full transcript and summary stored on completion

## Architecture Comparison

### Streaming vs. Upload-then-Process

| Aspect | Streaming (Current) | Upload-then-Process |
|--------|-------------------|---------------------|
| **Latency** | Low (real-time updates) | High (wait for upload) |
| **Reliability** | Resilient to network drops | Single point of failure |
| **Scalability** | Handles long sessions well | Memory intensive for large files |
| **User Experience** | Live feedback | Delayed results |
| **Implementation Complexity** | Higher (WebSocket, buffering) | Lower (simple upload) |

### WebRTC vs. MediaRecorder

| Aspect | MediaRecorder (Current) | WebRTC |
|--------|------------------------|--------|
| **Latency** | Low | Very Low |
| **Reliability** | Good | Excellent (peer-to-peer) |
| **Scalability** | Server-side processing | Requires more infrastructure |
| **Browser Support** | Excellent | Good (requires additional setup) |
| **Implementation Complexity** | Moderate | Higher (signaling, STUN/TURN) |

**Decision Rationale**: MediaRecorder was chosen for its simplicity, excellent browser support, and sufficient latency for transcription use cases. WebRTC would add complexity without significant benefits for this application.

## Long-Session Scalability Strategy

ScribeAI is designed to handle sessions of 1+ hours through several architectural decisions:

1. **Chunked Processing**: Audio is processed in 5-second chunks (optimized for real-time transcription) rather than waiting for the entire session. This prevents memory overload and provides incremental transcription results with low latency.

2. **Server-Side Buffering**: Audio chunks are buffered on the server with a 2GB per-session limit. This allows the server to continue processing even if the client disconnects temporarily.

3. **Disk Persistence**: Audio chunks are saved to disk for crash recovery. If the server restarts, it can resume processing from saved chunks.

4. **Database Optimization**: Transcript chunks are stored incrementally in the database, allowing for real-time updates without loading the entire transcript into memory.

5. **Streaming Architecture**: Using WebSockets instead of HTTP uploads allows for continuous streaming without timeouts or memory issues associated with large file uploads.

6. **Connection Resilience**: Heartbeat mechanism (ping/pong every 10s) detects disconnections. Client-side queuing ensures audio chunks aren't lost during brief network interruptions.

7. **State Management**: Session state is persisted in the database, allowing recovery of active sessions after server restarts.

This architecture scales horizontally by running multiple WebSocket server instances behind a load balancer, with session affinity to ensure chunks for a session go to the same server instance.

## API Endpoints

### Authentication (Better Auth)
- `POST /api/auth/sign-up/email` - Register new user
- `POST /api/auth/sign-in/email` - Sign in
- `POST /api/auth/sign-out` - Sign out
- `GET /api/auth/get-session` - Get current session

### Sessions
- `GET /api/sessions` - List all user sessions
- `GET /api/sessions/[id]` - Get session details

### WebSocket Events

**Client → Server:**
- `start-recording` - Initialize new recording session
- `audio-chunk` - Send audio chunk (`{ sessionId, audioData, mimeType, audioLevel, chunkId }`)
- `pause-recording` - Pause recording
- `resume-recording` - Resume recording
- `stop-recording` - Stop and process recording
- `cancel-recording` - Cancel recording

**Server → Client:**
- `recording-started` - Recording initialized
- `chunk-received` - Audio chunk acknowledged (`{ sessionId, chunkId }`)
- `recording-paused` - Recording paused
- `recording-resumed` - Recording resumed
- `status-update` - Status change notification
- `recording-completed` - Recording finished with transcript and summary
- `error` - Error occurred

## Audio Fidelity & Debugging

- **Per-chunk audio energy**: The browser continuously samples RMS levels (for mic and tab capture) and ships the normalized value with each chunk. The server skips clearly silent chunks and stores the value as `confidence` on every `TranscriptChunk`.
- **Deterministic stitching**: The Socket.io server persists every raw chunk, replays them through FFmpeg’s concat demuxer, and hashes the combined buffer. Duplicate hashes are dropped before hitting Gemini which removes “stuck” transcripts.
- **Automatic MP3 snapshots**: When `SAVE_MP3_DEBUG=true` (default in development) the stitched MP3 is preserved under `server/audio/sessions/<sessionId>/debug/`. This is the exact audio Gemini heard, so QA can replay mis-transcribed chunks instantly.
- **Stricter prompting & hygiene**: Gemini now receives a consistent “system” preamble, explicit continuity instructions, and additional post-processing removes non-verbal placeholders (e.g. `[Speaker 1]: [High-pitched tone]`) instead of surfacing them as text.
- **Chunk metadata everywhere**: Each `audio-chunk` message carries a deterministic `chunkId`, travels through the IndexedDB queue, and is acknowledged by the server so we never drop a chunk silently.

## Development

### Available Scripts

```bash
# Development
npm run dev              # Start both Next.js and WebSocket server
npm run dev:next         # Start only Next.js
npm run dev:server       # Start only WebSocket server

# Database
npm run prisma:migrate   # Run database migrations
npm run prisma:studio    # Open Prisma Studio
npm run prisma:generate  # Generate Prisma Client

# Production
npm run build            # Build Next.js app
npm start                # Start production server
```

### Code Quality

- ESLint for linting
- Prettier for code formatting
- TypeScript for type safety
- JSDoc comments for documentation

## Testing Checklist

- [ ] Record 1-minute mic session → verify transcript accuracy
- [ ] Record tab audio from Google Meet → verify system audio capture
- [ ] Pause/resume mid-session → verify continuity
- [ ] Simulate network drop → verify reconnection
- [ ] Test 10+ minute session → verify chunking and memory usage
- [ ] Export transcript → verify formatting
- [ ] Device turned off during recording → verify server continues buffering

## Deployment

### Environment Variables

Ensure all environment variables are set in your production environment:

- `DATABASE_URL` - Production Postgres connection string
- `BETTER_AUTH_SECRET` - Strong random secret
- `BETTER_AUTH_URL` - Production URL
- `GEMINI_API_KEY` - Google Gemini API key
- `WEBSOCKET_URL` - Production WebSocket server URL
- `FRONTEND_URL` - Production frontend URL

### Database Migration

Run migrations in production:

```bash
npm run prisma:migrate
```

### WebSocket Server

Deploy the WebSocket server separately or use a process manager like PM2:

```bash
cd server
npm install -g pm2
pm2 start npm --name "scribeai-server" -- start
```

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
