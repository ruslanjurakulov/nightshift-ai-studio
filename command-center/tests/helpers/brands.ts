/**
 * AI providers, model families and competitors the public pages must never
 * name. The public copy describes what Nightshift does, not whose model does
 * it: a provider named there is a promise the operator cannot keep the day the
 * model behind a tool changes, and a competitor named there is a claim about
 * someone else's product. Payment (Paddle, the Merchant of Record) and Google
 * (the YouTube sign-in) are deliberately not in this list — the law and
 * Google's OAuth review require those two to be named.
 */
export const PROVIDER_BRANDS =
  /\b(?:openai|chatgpt|gpt-?\d|dall-?e|sora|anthropic|claude|gemini|imagen|veo|nano ?banana|elevenlabs|eleven labs|kling|runway|luma|minimax|hailuo|flux|black forest|stability|stable diffusion|ideogram|recraft|fal\.ai|replicate|seedance|bytedance|hunyuan|pixverse|suno|udio|cartesia|deepgram|pexels|pixabay|midjourney|pika|heygen|synthesia|krea|higgsfield|magiclight|vidiq|capcut|inshot)\b/i;
