import { PROVIDERS } from "../constants.ts";

export const OPENAI_VOICES = [
  { name: "alloy", gender: "Neutral" },
  { name: "ash", gender: "Male" },
  { name: "ballad", gender: "Male" },
  { name: "coral", gender: "Female" },
  { name: "echo", gender: "Male" },
  { name: "fable", gender: "Male" },
  { name: "nova", gender: "Female" },
  { name: "onyx", gender: "Male" },
  { name: "sage", gender: "Female" },
  { name: "shimmer", gender: "Female" },
  { name: "verse", gender: "Male" },
  { name: "marin", gender: "Female" },
  { name: "cedar", gender: "Male" },
];

export const GOOGLE_VOICES = [
  { name: "Achernar", gender: "Female" },
  { name: "Achird", gender: "Male" },
  { name: "Algenib", gender: "Male" },
  { name: "Algieba", gender: "Male" },
  { name: "Alnilam", gender: "Male" },
  { name: "Aoede", gender: "Female" },
  { name: "Autonoe", gender: "Female" },
  { name: "Callirrhoe", gender: "Female" },
  { name: "Charon", gender: "Male" },
  { name: "Despina", gender: "Female" },
  { name: "Enceladus", gender: "Male" },
  { name: "Erinome", gender: "Female" },
  { name: "Fenrir", gender: "Male" },
  { name: "Gacrux", gender: "Female" },
  { name: "Iapetus", gender: "Male" },
  { name: "Kore", gender: "Female" },
  { name: "Laomedeia", gender: "Female" },
  { name: "Leda", gender: "Female" },
  { name: "Orus", gender: "Male" },
  { name: "Pulcherrima", gender: "Female" },
  { name: "Puck", gender: "Male" },
  { name: "Rasalgethi", gender: "Male" },
  { name: "Sadachbia", gender: "Male" },
  { name: "Sadaltager", gender: "Male" },
  { name: "Schedar", gender: "Male" },
  { name: "Sulafat", gender: "Female" },
  { name: "Umbriel", gender: "Male" },
  { name: "Vindemiatrix", gender: "Female" },
  { name: "Zephyr", gender: "Female" },
  { name: "Zubenelgenubi", gender: "Male" },
];

export const ELEVENLABS_VOICES = [
  { name: "21m00Tcm4TlvDq8ikWAM", label: "Rachel", gender: "Female" },
  { name: "EXAVITQu4vr4xnSDxMaL", label: "Bella", gender: "Female" },
  { name: "ErXwobaYiN019PkySvjV", label: "Antoni", gender: "Male" },
  { name: "MF3mGyEYCl7XYWbV9V6O", label: "Elli", gender: "Female" },
  { name: "TxGEqnHWrfWFTfGW9XjX", label: "Josh", gender: "Male" },
  { name: "VR6AewLTigWG4xSOukaG", label: "Arnold", gender: "Male" },
  { name: "pNInz6obpgDQGcFmaJgB", label: "Adam", gender: "Male" },
  { name: "yoZ06aMxZJJ28mfd3POQ", label: "Sam", gender: "Male" },
];

export const INWORLD_VOICES = [
  {
    name: "Abby",
    gender: "Female",
    description:
      "Bright, eager American female child voice, ideal for animated characters, upbeat educational content, and lively kids' commercials.",
  },
  {
    name: "Aditya",
    gender: "Male",
    description:
      "Confident, natural Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Alaric",
    gender: "Male",
    description:
      "Wise, gravelly male voice, ideal for RPG narration, audiobooks, and gaming.",
  },
  {
    name: "Alex",
    gender: "Male",
    description:
      "Energetic and expressive mid-range male voice, with a mildly nasal quality",
  },
  {
    name: "Amara",
    gender: "Female",
    description:
      "Warm, professional Nigerian female voice, ideal for customer service, narration, and support.",
  },
  {
    name: "Amina",
    gender: "Female",
    description:
      "Warm, inviting West African female voice, ideal for community outreach, cultural storytelling, and educational workshops.",
  },
  {
    name: "Andoy",
    gender: "Male",
    description:
      "Friendly, easygoing Filipino male voice, ideal for customer service, e-learning, and support.",
  },
  {
    name: "Anjali",
    gender: "Female",
    description:
      "A confident and articulate Indian female voice, ideal for professional training materials.",
  },
  {
    name: "Arjun",
    gender: "Male",
    description:
      "Clear, composed Indian male voice, well-suited for instructional webinars and technology explainers.",
  },
  {
    name: "Ashley",
    gender: "Female",
    description: "A warm, natural female voice",
  },
  {
    name: "Avery",
    gender: "Male",
    description:
      "Youthful, performative male voice, suited for gameshow-style hosting, energetic presenter reads, and expressive young character parts.",
  },
  {
    name: "Banjo",
    gender: "Male",
    description:
      "Laid-back, genial Australian male voice, ideal for lifestyle content, travel, and casual narration.",
  },
  {
    name: "Beatrice",
    gender: "Female",
    description:
      "Rich, authoritative British female voice, ideal for audiobooks, documentary, and narration.",
  },
  {
    name: "Bianca",
    gender: "Female",
    description:
      "Deep, controlled female voice, ideal for serious corporate reads, composed documentary segments, and measured authority-led explainers.",
  },
  {
    name: "Blake",
    gender: "Male",
    description:
      "Rich, intimate male voice, perfect for audiobooks, romantic content, and reassuring narration",
  },
  {
    name: "Boonleng",
    gender: "Male",
    description:
      "Confident, conversational Singaporean male voice, ideal for e-learning, customer service, and support.",
  },
  {
    name: "Brandon",
    gender: "Male",
    description:
      "Bold, strident male voice, ideal for structured announcements, news-style reads, and direct promotional messaging.",
  },
  {
    name: "Brian",
    gender: "Male",
    description:
      "Friendly, encouraging American male voice, ideal for educational tutorials, motivational content, and instructional videos.",
  },
  {
    name: "Brick",
    gender: "Male",
    description:
      "Playful, bombastic male voice, ideal for game shows, interactive entertainment, and hosting.",
  },
  {
    name: "Callum",
    gender: "Male",
    description:
      "Casual and friendly Australian male voice, ideal for informal instructional content.",
  },
  {
    name: "Carter",
    gender: "Male",
    description:
      "Energetic, mature radio announcer-style male voice, great for storytelling, pep talks, and voiceovers.",
  },
  {
    name: "Cedric",
    gender: "Male",
    description:
      "Crisp, measured male voice, ideal for formal announcements, premium trailer narration, and command-forward presentation scripts.",
  },
  {
    name: "Celeste",
    gender: "Female",
    description:
      "Soft, whispery female voice, ideal for ASMR videos, soothing lullabies, and gentle mindfulness sessions.",
  },
  {
    name: "Chioma",
    gender: "Female",
    description:
      "Bright, friendly Nigerian female voice, ideal for customer service, narration, and support.",
  },
  {
    name: "Chip",
    gender: "Male",
    description:
      "Cheerful, witty male voice, ideal for game shows, interactive entertainment, and hosting.",
  },
  {
    name: "Chloe",
    gender: "Female",
    description:
      "Thoughtful, introspective youthful female voice, perfect for coming-of-age narratives, personal growth stories, and emotional teen dramas.",
  },
  {
    name: "Claire",
    gender: "Female",
    description:
      "Warm, gentle Eastern European female voice, ideal for bedtime stories, relaxation podcasts",
  },
  {
    name: "Clive",
    gender: "Male",
    description:
      "British-accented English-language male voice with a calm, cordial quality",
  },
  {
    name: "Conrad",
    gender: "Male",
    description:
      "Gruff, weathered male voice, perfect for detective archetypes, hard-edged audiobook roles, and serious investigative narration.",
  },
  {
    name: "Cooper",
    gender: "Male",
    description:
      "Casual, warm Australian male voice, ideal for lifestyle content, travel, and casual narration.",
  },
  {
    name: "Cordelia",
    gender: "Female",
    description:
      "Refined, composed British female voice, ideal for audiobooks, documentary, and narration.",
  },
  {
    name: "Craig",
    gender: "Male",
    description: "Older British male with a refined and articulate voice",
  },
  {
    name: "Dalisay",
    gender: "Female",
    description:
      "Bright, approachable Filipino female voice, ideal for customer service, e-learning, and support.",
  },
  {
    name: "Damon",
    gender: "Male",
    description:
      "Calm, raspy male voice, suited for moody narration, atmospheric roleplay characters, and grounded meditative reads with subtle tension.",
  },
  {
    name: "Darlene",
    gender: "Female",
    description:
      "Soothing, comforting Southern female voice, ideal for bedtime stories, family-centered commercials, and nostalgic narrations.",
  },
  {
    name: "Deborah",
    gender: "Female",
    description: "Warm, peaceful female voice with a calm tone",
  },
  {
    name: "Dennis",
    gender: "Male",
    description: "Middle-aged man with a smooth, calm and friendly voice",
  },
  {
    name: "Derek",
    gender: "Male",
    description:
      "Steady, professional, composed American male voice, ideal for banking support, account inquiries, and service escalation calls.",
  },
  {
    name: "Dhruv",
    gender: "Male",
    description:
      "Professional, measured Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Dominus",
    gender: "Male",
    description:
      "Robotic, deep male voice with a menacing quality. Perfect for villains",
  },
  {
    name: "Duncan",
    gender: "Male",
    description:
      "Warm, articulate British male voice for customer support and education.",
  },
  {
    name: "Edward",
    gender: "Male",
    description: "American male with a emphatic, confident and streetwise tone",
  },
  {
    name: "Eldrin",
    gender: "Male",
    description:
      "Sage, resonant male voice, ideal for RPG narration, audiobooks, and gaming.",
  },
  {
    name: "Eleanor",
    gender: "Female",
    description:
      "Polished, approachable British female voice for support and learning.",
  },
  {
    name: "Elizabeth",
    gender: "Female",
    description:
      "Professional middle-aged woman, perfect for narrations and voiceovers",
  },
  {
    name: "Elliot",
    gender: "Male",
    description:
      "A calm, steady male voice, suitable for nature documentaries, general informational content, and relaxed narrations.",
  },
  {
    name: "Emeka",
    gender: "Male",
    description:
      "Warm, conversational Nigerian male voice, ideal for customer service, narration, and support.",
  },
  {
    name: "Emil",
    gender: "Male",
    description:
      "Bright, upbeat Filipino male voice, ideal for customer service, e-learning, and support.",
  },
  {
    name: "Ethan",
    gender: "Male",
    description:
      "Assured, precise male voice, perfect for tech tutorials, detailed gadget overviews, and captivating product demonstrations.",
  },
  {
    name: "Evan",
    gender: "Male",
    description:
      "Friendly, approachable, easygoing male voice, ideal for onboarding calls, retail assistance, and customer check-ins.",
  },
  {
    name: "Evelyn",
    gender: "Female",
    description:
      "A gentle and intimate female voice, ideal for personal ASMR content, affirmations, and close, calming conversations.",
  },
  {
    name: "Felix",
    gender: "Male",
    description:
      "Calm, friendly British male voice, ideal for help and tutorials.",
  },
  {
    name: "Folake",
    gender: "Female",
    description:
      "Clear, approachable Nigerian female voice, ideal for customer service, narration, and support.",
  },
  {
    name: "Freddie",
    gender: "Male",
    description:
      "Young, casual British male voice, ideal for conversational assistants, podcasts, and narration.",
  },
  {
    name: "Gareth",
    gender: "Male",
    description:
      "Soothing, gentle male voice, ideal for guided meditations, mindfulness exercises, and relaxation-focused wellness content.",
  },
  {
    name: "Graham",
    gender: "Male",
    description:
      "Profound, authoritative British male voice, perfect for historical documentaries, luxury brand advertisements, and educational content.",
  },
  {
    name: "Grant",
    gender: "Male",
    description:
      "Calm, attentive, helpful male voice, ideal for insurance claims, troubleshooting walkthroughs, and helpdesk interactions.",
  },
  {
    name: "Hades",
    gender: "Male",
    description:
      "Commanding and gruff male voice, think an omniscient narrator or castle guard",
  },
  {
    name: "Hamish",
    gender: "Male",
    description:
      "Friendly and casual Australian male voice, ideal for character-driven roles and upbeat fitness.",
  },
  {
    name: "Hana",
    gender: "Female",
    description:
      "Bright, expressive young female voice, perfect for storytelling, gaming, and playful content",
  },
  {
    name: "Hank",
    gender: "Male",
    description:
      "Warm, laid-back Southern male voice, ideal for travel documentaries, heritage storytelling, and down-to-earth podcast ads.",
  },
  {
    name: "Huiling",
    gender: "Female",
    description:
      "Bright, approachable Singaporean female voice, ideal for e-learning, customer service, and support.",
  },
  {
    name: "Indi",
    gender: "Female",
    description:
      "Bright, casual Australian female voice, ideal for lifestyle content, travel, and casual narration.",
  },
  {
    name: "Ishaan",
    gender: "Male",
    description:
      "Confident, natural Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Jake",
    gender: "Male",
    description:
      "Amiable, introspective male voice, ideal for motivational talks, personal growth content, and charming interviews.",
  },
  {
    name: "James",
    gender: "Male",
    description:
      "Vibrant, expressive male voice, perfect for animated video content, lively event hosting, and captivating children's stories.",
  },
  {
    name: "Jarrah",
    gender: "Male",
    description:
      "Easygoing, grounded Australian male voice, ideal for lifestyle content, travel, and casual narration.",
  },
  {
    name: "Jason",
    gender: "Male",
    description:
      "Lucid, engrossing male voice, ideal for tech tips, creative productivity hacks, and supportive user interface tutorials.",
  },
  {
    name: "Jessica",
    gender: "Female",
    description:
      "Encouraging, articulate American female voice, perfect for self-help audiobooks, warm customer service messages, and clear e-learning modules.",
  },
  {
    name: "Jonah",
    gender: "Male",
    description:
      "Soothing, calm male voice, great for tutorial guidance, reassuring support flows, and gentle instructional narration with steady pacing.",
  },
  {
    name: "Joy",
    gender: "Female",
    description:
      "Gentle, steady female voice, ideal for customer support, sensitive contexts, and help lines.",
  },
  {
    name: "Julia",
    gender: "Female",
    description:
      "Quirky, high-pitched female voice that delivers lines with playful energy",
  },
  {
    name: "Junhao",
    gender: "Male",
    description:
      "Bright, easygoing Singaporean male voice, ideal for e-learning, customer service, and support.",
  },
  {
    name: "Kabir",
    gender: "Male",
    description:
      "Bright, helpful Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Kayla",
    gender: "Female",
    description:
      "Enthusiastic, youthful female voice, ideal for reaction videos, trendy product reviews, and energetic lifestyle vlogs.",
  },
  {
    name: "Kelsey",
    gender: "Female",
    description:
      "Warm, empathetic, reassuring female voice, ideal for phone support, appointment confirmations, and customer success calls.",
  },
  {
    name: "Kenji",
    gender: "Male",
    description:
      "Stylized, low-key male voice, ideal for anime content, gaming, and dubbing.",
  },
  {
    name: "Lauren",
    gender: "Female",
    description:
      "Confident, friendly American female voice, ideal for corporate presentations, upbeat commercials, and engaging podcasts.",
  },
  {
    name: "Levi",
    gender: "Male",
    description:
      "Measured, ominous male voice, ideal for suspense narration, dark fantasy storytelling, and composed dramatic monologues.",
  },
  {
    name: "Liam",
    gender: "Male",
    description:
      "Upbeat, motivating Australian male voice, perfect for energizing workout sessions, lively event promotions, and informal lifestyle content.",
  },
  {
    name: "Liwa",
    gender: "Female",
    description:
      "Gentle, patient Filipino female voice, ideal for customer service, e-learning, and support.",
  },
  {
    name: "Loretta",
    gender: "Female",
    description:
      "Inviting, folksy Southern female voice, perfect for cooking shows, heartwarming family tales, and cozy radio ads.",
  },
  {
    name: "Lucian",
    gender: "Male",
    description:
      "Brooding, foreboding male voice, suited for villainous character arcs, gothic drama scenes, and dark narrative worldbuilding.",
  },
  {
    name: "Luna",
    gender: "Female",
    description:
      "Calm, relaxing female voice, perfect for meditations, sleep stories, and mindfulness exercises",
  },
  {
    name: "Malcolm",
    gender: "Male",
    description:
      "Authoritative, manipulative male voice, perfect for cunning leaders, intense negotiation scenes, and persuasive villain speeches.",
  },
  {
    name: "Marcus",
    gender: "Male",
    description:
      "Authoritative, empathetic male voice, great for civic campaigns, community outreach explainers, and trustworthy commercial reads with emotional credibility.",
  },
  {
    name: "Maricel",
    gender: "Female",
    description:
      "Friendly, warm Filipino female voice, ideal for customer service, e-learning, and support.",
  },
  {
    name: "Mark",
    gender: "Male",
    description: "Energetic, expressive man with a rapid-fire delivery",
  },
  {
    name: "Marlene",
    gender: "Female",
    description:
      "Friendly, relaxed Southern female voice, ideal for home-style cooking tutorials, community event promotions, and downhome commercials.",
  },
  {
    name: "Matilda",
    gender: "Female",
    description:
      "Friendly, upbeat Australian female voice, ideal for lifestyle content, travel, and casual narration.",
  },
  {
    name: "Mia",
    gender: "Female",
    description:
      "Youthful, expressive female voice, ideal for adolescent characters, school-age animation dialogue, and bright coming-of-age narrative scenes.",
  },
  {
    name: "Miranda",
    gender: "Female",
    description:
      "Menacing, cold-hearted female voice, perfect for strategic villains, mysterious narratives",
  },
  {
    name: "Morgana",
    gender: "Female",
    description:
      "Cold, calculated female voice, ideal for gaming, audiobook villains, and horror.",
  },
  {
    name: "Mortimer",
    gender: "Male",
    description:
      "Gravelly, aggressive male character voice, ideal for fantasy villains and high-intensity game dialogue.",
  },
  {
    name: "Nadia",
    gender: "Female",
    description:
      "Personable, lively female voice, perfect for tutorial walkthroughs, friendly support messaging, and engaging narration for creator-led product content.",
  },
  {
    name: "Naomi",
    gender: "Female",
    description:
      "Warm, grounded female voice, perfect for narrative podcasting, people-first customer guidance, and emotionally real brand storytelling.",
  },
  {
    name: "Nate",
    gender: "Male",
    description:
      "Conversational, sociable male voice, great for customer support and friendly guidance",
  },
  {
    name: "Nikhil",
    gender: "Male",
    description:
      "Articulate, warm Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Oliver",
    gender: "Male",
    description:
      "Neutral and clear male voice, ideal for public announcements and educational information.",
  },
  {
    name: "Olivia",
    gender: "Female",
    description:
      "Young, British female with a friendly and helpful tone, conveying confidence and efficiency.",
  },
  {
    name: "Pippa",
    gender: "Female",
    description:
      "Friendly and casual Australian female voice, ideal for relaxed instructional content.",
  },
  {
    name: "Pixie",
    gender: "Female",
    description:
      "High-pitched, childlike female voice with a squeaky quality - great for a cartoon character",
  },
  {
    name: "Priya",
    gender: "Female",
    description: "Even-toned female voice with an Indian accent",
  },
  {
    name: "Reed",
    gender: "Male",
    description:
      "Clear, professional American male voice, well-suited for support and training.",
  },
  {
    name: "Ren",
    gender: "Male",
    description:
      "Cool, aloof male voice, ideal for anime content, gaming, and dubbing.",
  },
  {
    name: "Riley",
    gender: "Female",
    description:
      "Playful, youthful female voice, perfect for animated storytelling, upbeat game characters, and high-energy kid-focused digital content.",
  },
  {
    name: "Ronald",
    gender: "Male",
    description: "Confident, British man with a deep, gravelly voice",
  },
  {
    name: "Rosalind",
    gender: "Female",
    description:
      "Mature, warm British female voice, ideal for audiobooks, documentary, and narration.",
  },
  {
    name: "Rupert",
    gender: "Male",
    description:
      "Resonant, commanding British male voice, ideal for motivational speeches, epic film trailers, and dynamic corporate presentations.",
  },
  {
    name: "Saanvi",
    gender: "Female",
    description:
      "Crisp, articulate Indian female voice, ideal for dynamic e-learning modules, articulate documentary narrations, and vibrant travel vlogs.",
  },
  {
    name: "Sarah",
    gender: "Female",
    description:
      "Fast-talking young adult woman, with a questioning and curious tone",
  },
  {
    name: "Sebastian",
    gender: "Male",
    description:
      "Intimidating, steely male voice, perfect for ruthless antagonists, strategic power struggles, and chilling monologues.",
  },
  {
    name: "Selene",
    gender: "Female",
    description:
      "Soft, flirtatious female voice, ideal for companion-style interactions, charming game dialogue, and emotionally playful character-driven story scenes.",
  },
  {
    name: "Serena",
    gender: "Female",
    description:
      "Soft, nurturing female voice, perfect for mindfulness sessions, nature-inspired visualizations, and gentle wellness podcasts.",
  },
  {
    name: "Serene",
    gender: "Female",
    description:
      "Natural, poised Singaporean female voice, ideal for e-learning, customer service, and support.",
  },
  {
    name: "Shaun",
    gender: "Male",
    description: "Friendly, dynamic male voice great for conversations",
  },
  {
    name: "Shu",
    gender: "Female",
    description:
      "Confident, friendly Singaporean female voice, ideal for e-learning, customer service, and support.",
  },
  {
    name: "Simon",
    gender: "Male",
    description:
      "Articulate, insightful male voice, perfect for corporate presentations, technical tutorials, and steady news reporting.",
  },
  {
    name: "Snik",
    gender: "Male",
    description:
      "Hoarse, cunning male voice, perfect for devious goblin roles, fantasy heist scenarios, and trickster-themed animations.",
  },
  {
    name: "Sophie",
    gender: "Female",
    description:
      "Friendly British female voice, great for assistance and knowledge sharing.",
  },
  {
    name: "Tahlia",
    gender: "Female",
    description:
      "Sunny, easygoing Australian female voice, ideal for lifestyle content, travel, and casual narration.",
  },
  {
    name: "Tala",
    gender: "Female",
    description:
      "Friendly, warm Filipino female voice, ideal for customer service, e-learning, and support.",
  },
  {
    name: "Tessa",
    gender: "Female",
    description:
      "Upbeat, conversational Australian female voice, perfect for lifestyle vlogs, playful advertisements, and engaging social media content.",
  },
  {
    name: "Theodore",
    gender: "Male",
    description: "Gravelly male voice, with a time-worn quality",
  },
  {
    name: "Timothy",
    gender: "Male",
    description: "Lively, upbeat American male voice",
  },
  {
    name: "Trevor",
    gender: "Male",
    description:
      "Punchy, expressive male voice, perfect for energetic promos, announcer-driven reveals, and fast-moving scripted event intros.",
  },
  {
    name: "Tristan",
    gender: "Male",
    description:
      "Deliberate, controlled male voice, ideal for documentary narration, polished voiceover campaigns, and clear long-form infomercial storytelling.",
  },
  {
    name: "Tunde",
    gender: "Male",
    description:
      "Grounded, friendly Nigerian male voice, ideal for customer service, narration, and support.",
  },
  {
    name: "Tyler",
    gender: "Male",
    description:
      "Authoritative, insightful male voice, ideal for tech explainer videos, in-depth software reviews, and dynamic coding guides.",
  },
  {
    name: "Veronica",
    gender: "Female",
    description:
      "Intimidating, commanding female voice, perfect for ruthless antagonists, high-stakes negotiations, and chilling monologues.",
  },
  {
    name: "Victor",
    gender: "Male",
    description:
      "Ominous, sinister male voice, ideal for dark conspiracies, eerie suspense scenes, and enigmatic villain roles.",
  },
  {
    name: "Victoria",
    gender: "Female",
    description:
      "Silky, cunning British female voice, ideal for narrating intricate plots",
  },
  {
    name: "Vikram",
    gender: "Male",
    description:
      "Professional, measured Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Vinny",
    gender: "Male",
    description:
      "Gritty, assertive New York male voice, perfect for crime dramas, urban documentaries, and no-nonsense character roles.",
  },
  {
    name: "Wei",
    gender: "Male",
    description:
      "Confident, conversational Singaporean male voice, ideal for e-learning, customer service, and support.",
  },
  {
    name: "Wendy",
    gender: "Female",
    description: "Posh, middle-aged British female voice",
  },
  {
    name: "Winifred",
    gender: "Female",
    description:
      "Mature, warm British female voice, ideal for audiobooks, documentary, and narration.",
  },
  {
    name: "Yash",
    gender: "Male",
    description:
      "Articulate, warm Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Zadie",
    gender: "Female",
    description:
      "Punchy, expressive female voice, ideal for short-form social, UGC, and viral content.",
  },
  {
    name: "Zherong",
    gender: "Male",
    description:
      "Natural, helpful Singaporean male voice, ideal for e-learning, customer service, and support.",
  },
];

export const VOICES = {
  [PROVIDERS.OPENAI]: OPENAI_VOICES,
  [PROVIDERS.GOOGLE]: GOOGLE_VOICES,
  [PROVIDERS.ELEVENLABS]: ELEVENLABS_VOICES,
  [PROVIDERS.INWORLD]: INWORLD_VOICES,
};

export const DEFAULT_VOICES = {
  [PROVIDERS.OPENAI]: "echo",
  [PROVIDERS.GOOGLE]: "Kore",
  [PROVIDERS.ELEVENLABS]: "21m00Tcm4TlvDq8ikWAM",
  [PROVIDERS.INWORLD]: "Dennis",
};

