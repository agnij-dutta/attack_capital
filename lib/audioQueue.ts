/**
 * Client-side audio chunk queue using IndexedDB
 * Provides offline resilience by queuing chunks when network is unavailable
 */

const DB_NAME = "ScribeAI_AudioQueue";
const DB_VERSION = 2;
const STORE_NAME = "audioChunks";

interface QueuedChunk {
  id: string;
  sessionId: string;
  audioData: string; // Base64 encoded
  mimeType: string;
  timestamp: number;
  retryCount: number;
  audioLevel?: number | null;
  chunkId?: string;
}

/**
 * Initialize IndexedDB for audio chunk queue
 */
async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      let store: IDBObjectStore;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
      } else {
        store = request.transaction?.objectStore(STORE_NAME)!;
        if (!store.indexNames.contains("sessionId")) {
          store.createIndex("sessionId", "sessionId", { unique: false });
        }
        if (!store.indexNames.contains("timestamp")) {
          store.createIndex("timestamp", "timestamp", { unique: false });
        }
      }
    };
  });
}

/**
 * Add a chunk to the queue
 */
export async function queueChunk(
  sessionId: string,
  audioData: string,
  mimeType: string = "audio/webm",
  metadata?: { audioLevel?: number; chunkId?: string }
): Promise<void> {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    const generatedChunkId =
      (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : undefined) || `${sessionId}-${Date.now()}-${Math.random()}`;
    const chunkId = metadata?.chunkId || generatedChunkId;

    const chunk: QueuedChunk = {
      id: `${sessionId}-${Date.now()}-${Math.random()}`,
      sessionId,
      audioData,
      mimeType,
      timestamp: Date.now(),
      retryCount: 0,
      audioLevel: metadata?.audioLevel ?? null,
      chunkId,
    };

    await new Promise<void>((resolve, reject) => {
      const request = store.add(chunk);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    console.log(`[AudioQueue] Queued chunk for session ${sessionId}`);
  } catch (error) {
    console.error("[AudioQueue] Error queueing chunk:", error);
    throw error;
  }
}

/**
 * Get all queued chunks for a session
 */
export async function getQueuedChunks(sessionId: string): Promise<QueuedChunk[]> {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index("sessionId");

    return new Promise((resolve, reject) => {
      const request = index.getAll(sessionId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("[AudioQueue] Error getting queued chunks:", error);
    return [];
  }
}

/**
 * Remove a chunk from the queue after successful send
 */
export async function removeChunk(chunkId: string): Promise<void> {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    await new Promise<void>((resolve, reject) => {
      const request = store.delete(chunkId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("[AudioQueue] Error removing chunk:", error);
  }
}

/**
 * Increment retry count for a chunk
 */
export async function incrementRetryCount(chunkId: string): Promise<void> {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    const chunk = await new Promise<QueuedChunk>((resolve, reject) => {
      const request = store.get(chunkId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (chunk) {
      chunk.retryCount += 1;
      await new Promise<void>((resolve, reject) => {
        const request = store.put(chunk);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  } catch (error) {
    console.error("[AudioQueue] Error incrementing retry count:", error);
  }
}

/**
 * Clear all queued chunks for a session
 */
export async function clearSessionQueue(sessionId: string): Promise<void> {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index("sessionId");

    const chunks = await new Promise<QueuedChunk[]>((resolve, reject) => {
      const request = index.getAll(sessionId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    await Promise.all(chunks.map((chunk) => removeChunk(chunk.id)));
    console.log(`[AudioQueue] Cleared ${chunks.length} queued chunks for session ${sessionId}`);
  } catch (error) {
    console.error("[AudioQueue] Error clearing session queue:", error);
  }
}

/**
 * Get queue size for a session
 */
export async function getQueueSize(sessionId: string): Promise<number> {
  const chunks = await getQueuedChunks(sessionId);
  return chunks.length;
}


