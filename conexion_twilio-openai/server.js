import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import dotenv from "dotenv";
import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";
import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";

dotenv.config();

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Health
fastify.get("/", async () => ({ ok: true }));

// TwiML con WSS de tu dominio público (no localhost)
fastify.all("/incoming-call", async (req, reply) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host; // en Render llega
  const base = `https://${host}`;
  const wssBase = base.replace(/^http/i, "ws");
  const twiml = `
<Response>
  <Say>Gracias por llamar. Conectando con el asistente.</Say>
  <Connect><Stream url="${wssBase}/media-stream"/></Connect>
</Response>`.trim();
  reply.type("text/xml").send(twiml);
});


// *** ÚNICA ruta WS ***
// --- /media-stream SOLO WEBSOCKET (prueba eco) ---
fastify.get("/media-stream", { websocket: true }, async (connection, req) => {
  fastify.log.info({ url: req.url, ua: req.headers["user-agent"] }, "WS: intento de conexión");
  const ws = connection.socket;

  // polyfill para 'ws'
  if (typeof ws.addEventListener !== "function") ws.addEventListener = (ev, h) => ws.on(ev, h);
  if (typeof ws.removeEventListener !== "function") ws.removeEventListener = (ev, h) => ws.off(ev, h);

  ws.on("close", (code, reason) => fastify.log.warn({ code, reason: reason?.toString() }, "WS: cerrado"));
  ws.on("error", (err) => fastify.log.error({ err }, "WS: error"));

  try {
    // 1) Comprueba la API key antes de nada
    if (!process.env.OPENAI_API_KEY?.startsWith("sk-")) {
      fastify.log.error("OPENAI_API_KEY ausente o inválida");
      return ws.close();
    }

    // 2) Loggea los primeros mensajes que manda Twilio (debe llegar un 'start')
    let firstMsgLogged = false;
    ws.on("message", (buf) => {
      if (!firstMsgLogged) {
        firstMsgLogged = true;
        const preview = buf.toString("utf8").slice(0, 200);
        fastify.log.info({ preview }, "WS: primer mensaje recibido (debería ser 'start')");
      }
    });

    // 3) Conecta Realtime
    const { RealtimeAgent, RealtimeSession } = await import("@openai/agents/realtime");
    const { TwilioRealtimeTransportLayer } = await import("@openai/agents-extensions");

    const transport = new TwilioRealtimeTransportLayer({ twilioWebSocket: ws });

    const agent = new RealtimeAgent({
      name: "Angelina (Flame Stone)",
      state: { language_preference: "es" },
      // SUGERENCIA: empieza hablando para validar audio de salida
      instructions: `Eres Angelina… (tu prompt completo aquí). 
Al inicio de la llamada, saluda brevemente: "Hola, soy Angelina de Flame Stone. ¿En qué puedo ayudarte?"`,
    });

    const session = new RealtimeSession(agent, {
      transport,
      config: {
        input_audio_format: "g711_ulaw",       // audio entrante de Twilio
        audio: { output: { voice: "verse" } }, // TTS de salida
        // model: "gpt-4o-realtime-preview",    // opcional si quieres fijarlo
      },
    });

    await session.connect({ apiKey: process.env.OPENAI_API_KEY });
    fastify.log.info("Realtime: sesión conectada ✅");
  } catch (e) {
    fastify.log.error(e, "Fallo en /media-stream");
    try { ws.close(); } catch {}
  }
});



// Arranque
fastify.listen({ port: process.env.PORT || 5050, host: "0.0.0.0" })
  .then(addr => fastify.log.info(`Escuchando en ${addr}`))
  .catch(err => { fastify.log.error(err); process.exit(1); });

