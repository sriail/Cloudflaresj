import { connect } from "cloudflare:sockets";

// --- Wisp Protocol Constants ---
const PACKET_TYPES = {
  CONNECT: 0x01,
  DATA: 0x02,
  CONTINUE: 0x03,
  CLOSE: 0x04,
  INFO: 0x05,
};

const STREAM_TYPES = {
  TCP: 0x01,
  UDP: 0x02,
};

const CLOSE_REASONS = {
  UNKNOWN: 0x01,
  VOLUNTARY: 0x02,
  NETWORK_ERROR: 0x03,
  INCOMPATIBLE: 0x04,
  INVALID_INFO: 0x41,
  UNREACHABLE: 0x42,
  NO_RESPONSE: 0x43,
  CONN_REFUSED: 0x44,
  HOST_BLOCKED: 0x48,
};

const EXT_IDS = {
  UDP: 0x01,
  AUTH_PASS: 0x02,
  AUTH_KEY: 0x03,
  MOTD: 0x04,
  STREAM_CONFIRM: 0x05,
};

const MAX_BUFFER_SIZE = 128;
const MAX_WS_FRAME_SIZE = 65536; // 64KB chunks to prevent CF frame size issues

// --- Wisp Packet Utilities (Mirrors wisp-js packet.mjs) ---
class WispBuffer {
  constructor(data) {
    if (typeof data === 'number') {
      data = new Uint8Array(data);
    } else if (data instanceof ArrayBuffer) {
      data = new Uint8Array(data);
    }
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.size = data.length;
  }
  
  concat(buffer) {
    let new_bytes = new Uint8Array(this.size + buffer.size);
    new_bytes.set(this.bytes, 0);
    new_bytes.set(buffer.bytes, this.size);
    return new WispBuffer(new_bytes);
  }
}

function buildPacket(type, stream_id, payload_buf = new WispBuffer(new Uint8Array(0))) {
  let packet_bytes = new Uint8Array(5 + payload_buf.size);
  let view = new DataView(packet_bytes.buffer);
  view.setUint8(0, type);
  view.setUint32(1, stream_id, true); // little-endian
  packet_bytes.set(payload_buf.bytes, 5);
  return packet_bytes;
}

function buildInfoPayload(major, minor, exts = []) {
  let ext_buf = new WispBuffer(new Uint8Array(0));
  for (let ext of exts) {
    let ext_data = ext.data || new Uint8Array(0);
    let new_ext_bytes = new Uint8Array(5 + ext_data.length);
    let new_ext_view = new DataView(new_ext_bytes.buffer);
    new_ext_view.setUint8(0, ext.id);
    new_ext_view.setUint32(1, ext_data.length, true);
    new_ext_bytes.set(ext_data, 5);
    ext_buf = ext_buf.concat(new WispBuffer(new_ext_bytes));
  }
  
  let payload_bytes = new Uint8Array(2);
  let payload_view = new DataView(payload_bytes.buffer);
  payload_view.setUint8(0, major);
  payload_view.setUint8(1, minor);
  let payload = new WispBuffer(payload_bytes);
  return payload.concat(ext_buf);
}

function buildContinuePayload(buffer_remaining) {
  let bytes = new Uint8Array(4);
  let view = new DataView(bytes.buffer);
  view.setUint32(0, buffer_remaining, true);
  return new WispBuffer(bytes);
}

function buildClosePayload(reason) {
  let bytes = new Uint8Array(1);
  bytes[0] = reason;
  return new WispBuffer(bytes);
}

function sendClose(ws, streamId, reason) {
  const payload = buildClosePayload(reason);
  ws.send(buildPacket(PACKET_TYPES.CLOSE, streamId, payload));
}

// --- Cloudflare Worker Entry Point ---
export default {
  async fetch(request, env, ctx) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const [client, server] = new WebSocketPair();
    server.accept();
    
    const protocol = request.headers.get("Sec-WebSocket-Protocol");
    const isV2 = protocol !== null;
    
    const responseHeaders = new Headers();
    if (isV2) {
      // Acknowledge the subprotocol to satisfy the browser's WebSocket handshake
      responseHeaders.set("Sec-WebSocket-Protocol", protocol.split(",")[0].trim());
    }

    ctx.waitUntil(handleWispSession(server, isV2));
    
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: responseHeaders
    });
  },
};

// --- Wisp Session Handler ---
async function handleWispSession(ws, isV2) {
  const streams = new Map(); // streamId -> { socket, writer, closed }
  let handshakeComplete = false;

  if (isV2) {
    // Send Server INFO packet immediately
    const serverInfoPayload = buildInfoPayload(2, 1, [{ id: EXT_IDS.STREAM_CONFIRM }]);
    ws.send(buildPacket(PACKET_TYPES.INFO, 0, serverInfoPayload));
  } else {
    // Wisp V1: Send initial CONTINUE immediately
    const continuePayload = buildContinuePayload(MAX_BUFFER_SIZE);
    ws.send(buildPacket(PACKET_TYPES.CONTINUE, 0, continuePayload));
    handshakeComplete = true;
  }

  ws.addEventListener("message", async (event) => {
    try {
      const data = new Uint8Array(event.data);
      if (data.length < 5) return; // Invalid packet size

      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const type = view.getUint8(0);
      const streamId = view.getUint32(1, true);
      
      const payload_bytes = data.subarray(5);
      const payload = new WispBuffer(payload_bytes);

      if (!handshakeComplete) {
        if (type === PACKET_TYPES.INFO) {
          handshakeComplete = true;
          // Send initial global buffer size
          const continuePayload = buildContinuePayload(MAX_BUFFER_SIZE);
          ws.send(buildPacket(PACKET_TYPES.CONTINUE, 0, continuePayload));
        }
        return;
      }

      switch (type) {
        case PACKET_TYPES.CONNECT:
          await handleConnect(ws, streams, streamId, payload);
          break;
        case PACKET_TYPES.DATA:
          await handleData(ws, streams, streamId, payload);
          break;
        case PACKET_TYPES.CLOSE:
          handleClose(streams, streamId);
          break;
      }
    } catch (err) {
      console.error("Error processing message:", err);
    }
  });

  ws.addEventListener("close", () => {
    for (const [id, stream] of streams.entries()) {
      try { stream.socket.close(); } catch (e) {}
    }
    streams.clear();
  });

  ws.addEventListener("error", (err) => {
    console.error("WebSocket error:", err);
  });
}

async function handleConnect(ws, streams, streamId, payload) {
  if (payload.size < 3) return; // Invalid CONNECT payload
  
  const streamType = payload.view.getUint8(0);
  const port = payload.view.getUint16(1, true);
  const hostname = new TextDecoder().decode(payload.bytes.subarray(3));

  if (streamType === STREAM_TYPES.UDP) {
    // UDP is unsupported on CF Workers
    sendClose(ws, streamId, CLOSE_REASONS.INVALID_INFO);
    return;
  }

  try {
    const tcpSocket = connect({ hostname, port });
    
    const writer = tcpSocket.writable.getWriter();
    streams.set(streamId, { socket: tcpSocket, writer, closed: false });

    await tcpSocket.opened;

    // Send CONTINUE packet to confirm stream is open (Ext 0x05)
    const continuePayload = buildContinuePayload(MAX_BUFFER_SIZE);
    ws.send(buildPacket(PACKET_TYPES.CONTINUE, streamId, continuePayload));

    // Start reading from the TCP socket and forwarding to WebSocket
    pipeSocketToWs(ws, streams, streamId, tcpSocket);

  } catch (err) {
    console.error(`Connection failed to ${hostname}:${port}`, err);
    sendClose(ws, streamId, CLOSE_REASONS.CONN_REFUSED); 
  }
}

async function handleData(ws, streams, streamId, payload) {
  const stream = streams.get(streamId);
  if (!stream || stream.closed) return;

  try {
    await stream.writer.write(payload.bytes);
    
    // Send CONTINUE packet to inform the client they can send more data
    const continuePayload = buildContinuePayload(MAX_BUFFER_SIZE);
    ws.send(buildPacket(PACKET_TYPES.CONTINUE, streamId, continuePayload));
  } catch (err) {
    console.error("Write to TCP failed:", err);
    stream.closed = true;
  }
}

function handleClose(streams, streamId) {
  const stream = streams.get(streamId);
  if (stream) {
    stream.closed = true;
    try { stream.writer.close(); } catch (e) {}
    try { stream.socket.close(); } catch (e) {}
    streams.delete(streamId);
  }
}

async function pipeSocketToWs(ws, streams, streamId, tcpSocket) {
  const stream = streams.get(streamId);
  if (!stream) return;

  const reader = tcpSocket.readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      // Chunk large TCP reads to avoid exceeding WebSocket frame size limits
      let offset = 0;
      while (offset < value.length) {
        const chunk = value.subarray(offset, offset + MAX_WS_FRAME_SIZE);
        const dataPayload = new WispBuffer(chunk);
        ws.send(buildPacket(PACKET_TYPES.DATA, streamId, dataPayload));
        offset += chunk.length;
      }
    }
  } catch (err) {
    // Socket read error / closure
  } finally {
    reader.releaseLock();
    if (!stream.closed) {
      // 0x02: Voluntary stream closure (TCP disconnected cleanly)
      sendClose(ws, streamId, CLOSE_REASONS.VOLUNTARY);
      handleClose(streams, streamId);
    }
  }
}