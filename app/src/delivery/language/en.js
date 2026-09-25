/* English. See index.js for how a language module is used and how to add one. */
export default {
  code: "en",
  name: "English",
  speechLocale: "en-US",

  phrases: {
    /* First text after a missed call. Alone it reads
         "Hi, this is AA Eagle Plumbing. Sorry we missed your call. How can we help?"
       and in a bilingual text the business name leads once and each language
       contributes its body line. The body is what a client can reword. */
    textback_intro: "Hi, this is {business}.",
    textback: "Sorry we missed your call. How can we help?",

    followup_intro: "Hi again from {business}.",
    followup: "Do you still need help? Just reply to this text.",

    optout_confirm: "{business}: you're unsubscribed and won't get more texts from us. Reply START to resubscribe.",

    owner_alert: "Frontline Ops: new lead for {business}. {lead} texted: \"{snippet}\" Call or text them back.",
    media_placeholder: "(sent a photo)",

    test: "Frontline Ops test: text-back for {business} is connected to {line}. No reply needed.",

    greeting_texted: "Thanks for calling {business}. Sorry we missed you. We just sent you a text message so we can help you right away.",
    greeting_plain: "Thanks for calling {business}. Sorry we missed you. Please try again a little later.",
  },

  /* Whole-message keywords, matched case-insensitively. */
  optOutKeywords: ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"],
  optInKeywords: ["START", "UNSTOP", "YES"],

  /* Common words in a short customer text, for telling languages apart. */
  markers: [
    "hi", "hello", "hey", "thanks", "thank", "please", "need", "have", "the", "is", "my",
    "can", "you", "your", "today", "tomorrow", "how", "much", "what", "when", "yes", "help",
    "water", "kitchen", "bathroom", "leak", "leaking", "price", "quote", "appointment", "want",
    "come", "call", "called", "sorry", "also", "but", "very", "good", "would", "could", "it's",
    "i'm", "im", "and", "with", "there", "broken", "fix", "house", "home", "morning", "afternoon",
  ],
};
