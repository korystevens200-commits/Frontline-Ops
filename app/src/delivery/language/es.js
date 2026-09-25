/* Español. See index.js for how a language module is used and how to add one.
   Usted throughout: these go to a business's customers. */
export default {
  code: "es",
  name: "Español",
  speechLocale: "es-US",

  phrases: {
    textback_intro: "Hola, le escribe {business}.",
    textback: "Disculpe que no pudimos contestar. ¿En qué le podemos ayudar?",

    followup_intro: "Le saluda de nuevo {business}.",
    followup: "¿Todavía necesita ayuda? Responda a este mensaje.",

    optout_confirm: "{business}: ha sido dado de baja y no recibirá más mensajes. Responda START para volver a suscribirse.",

    owner_alert: "Frontline Ops: nuevo cliente potencial para {business}. {lead} escribió: \"{snippet}\" Llámelo o escríbale.",
    media_placeholder: "(envió una foto)",

    test: "Prueba de Frontline Ops: los mensajes de {business} están conectados a {line}. No necesita responder.",

    greeting_texted: "Gracias por llamar a {business}. Disculpe que no pudimos contestar. Le acabamos de enviar un mensaje de texto para ayudarle enseguida.",
    greeting_plain: "Gracias por llamar a {business}. Disculpe que no pudimos contestar. Por favor llame de nuevo más tarde.",
  },

  /* Carriers' standard opt-out words are English; these are what a Spanish
     speaker actually sends. Twilio does not act on them by default, so the
     app records the opt-out and confirms it itself. */
  optOutKeywords: ["PARAR", "ALTO", "BAJA", "CANCELAR", "DETENER"],
  optInKeywords: [],

  markers: [
    "hola", "gracias", "por", "favor", "necesito", "tengo", "que", "qué", "el", "la", "los",
    "las", "una", "un", "es", "está", "esta", "para", "con", "mi", "sí", "si", "puede", "pueden",
    "cuánto", "cuanto", "cuándo", "cuando", "hoy", "mañana", "buenos", "buenas", "días", "dias",
    "tardes", "noches", "ayuda", "casa", "aire", "agua", "cocina", "baño", "fuga", "precio",
    "cita", "quiero", "venir", "llamar", "llamé", "llamada", "perdón", "también", "pero", "muy",
    "bien", "y", "de", "se", "roto", "arreglar", "señor", "señora", "bueno", "claro",
  ],
};
