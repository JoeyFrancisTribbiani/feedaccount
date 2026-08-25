/**
 * 提示词生成库 — 生成 ComfyUI (Qwen) 文生图提示词
 *
 * 导出 generatePrompt(category)
 *   category = "jesus"  → 耶稣圣像类
 *   category = "beauty" → 美女图类
 *
 * 每次调用随机组合各维度元素拼出完整英文 prompt，
 * 结尾固定加画质词 "8K, ultra detailed, professional photography, trending, viral quality"。
 * 同时导出 getNegativePrompt(category) 返回对应负面提示词。
 */

const QUALITY_SUFFIX = "8K, ultra detailed, professional photography, trending, viral quality";

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function joinUnique(arr, count) {
  return shuffle(arr).slice(0, count).join(", ");
}

// ──────────────────────────────────────────────────────
// 耶稣圣像类
// ──────────────────────────────────────────────────────
const JESUS = {
  // 主体描述
  subjects: [
    "A radiant figure of Jesus Christ",
    "Jesus with a luminous serene face",
    "A divine image of Jesus Christ",
    "Jesus in flowing white robes",
    "A holy vision of Jesus",
    "Jesus with long wavy hair and a gentle beard",
    "A majestic figure of Jesus Christ",
    "Jesus with kind compassionate eyes",
    "A heavenly figure of Jesus Christ",
    "Jesus with arms open in blessing",
  ],
  // 场景
  scenes: [
    "on a mountain peak at golden sunset",
    "by the seashore in the early dawn light",
    "inside a grand cathedral with colorful stained-glass light streaming through",
    "in a vast wilderness under a star-filled sky",
    "above a sea of clouds with golden light breaking through",
    "in a peaceful olive garden at dawn",
    "before a glowing cross in the open field",
    "in a desert oasis surrounded by palms",
    "on a calm hilltop with dramatic clouds behind",
    "in a heavenly meadow filled with white lilies",
  ],
  // 姿态/动作
  poses: [
    "standing with his back to the camera, gazing up at the sky",
    "raising both hands outward in prayer",
    "kneeling on the ground, looking up to heaven",
    "pointing one finger toward the sky",
    "embracing a warm glowing light around him",
    "walking calmly on the surface of water",
    "sitting peacefully among wildflowers",
    "with arms spread wide in a welcoming gesture",
    "kneeling in deep prayer with folded hands",
    "standing atop a rock with arms raised to the heavens",
  ],
  // 光效
  lights: [
    "god rays / Tyndall light piercing through the clouds",
    "golden dust and floating particles of light",
    "a holy aura enveloping the whole body",
    "a glowing halo surrounding his head",
    "soft volumetric light beams from above",
    "shimmering sacred light radiating outward",
    "a crown of golden light behind him",
    "divine backlight creating a glowing silhouette",
  ],
  // 色调
  tones: [
    "warm golden color palette",
    "blue-purple dusk tones",
    "pure white holy palette",
    "amber and crimson warm tones",
    "soft pastel heavenly tones",
    "deep indigo and gold contrast",
    "ethereal white-gold tones",
    "warm sepia and gold tones",
  ],
  // 情绪/氛围
  moods: [
    "divine and awe-inspiring atmosphere",
    "majestic and heavenly mood",
    "spiritual and peaceful feeling",
    "sacred and serene atmosphere",
    "glorious and transcendent mood",
    "blessed and comforting aura",
    "holy and uplifting atmosphere",
    "reverent and sublime feeling",
  ],
  // 附加随机元素 (可选)
  extras: [
    "white doves flying across the scene",
    "a glowing cross of light in the background",
    "subtle rays of light forming a cross pattern",
    "an ancient scripture scroll unfurling nearby",
    "floating petals of light in the air",
    "a flock of white doves ascending into the sky",
    "a distant chapel silhouette on the horizon",
    "glowing scripture text faintly visible in the clouds",
  ],
  // 负面提示词
  negative:
    "lowres, blurry, distorted face, deformed hands, extra fingers, bad anatomy, watermark, text, signature, dark, scary, ugly, cartoon, anime, 3d render, plastic skin, oversaturated, grainy",
};

// ──────────────────────────────────────────────────────
// 美女图类
// ──────────────────────────────────────────────────────
const BEAUTY = {
  // 主体描述
  subjects: [
    "A beautiful young woman",
    "A gorgeous model with flawless skin",
    "An elegant and attractive woman",
    "A stunning girl with natural beauty",
    "A charming and graceful woman",
    "A pretty girl with captivating eyes",
    "A stylish and confident woman",
    "An alluring young lady",
    "A radiant and vivacious girl",
    "A sophisticated and fashionable woman",
  ],
  // 风格
  styles: [
    "fashion street photography style",
    "fresh campus aesthetic",
    "urban night photography style",
    "seaside vacation style",
    "cozy cafe lifestyle aesthetic",
    "sporty fitness style",
    "traditional Hanfu Chinese style",
    "vintage Western retro style",
    "Korean fashion editorial style",
    "minimalist high-end fashion style",
  ],
  // 服装
  outfits: [
    "wearing a flowing white dress",
    "in denim jacket and jeans",
    "in sporty activewear",
    "in an elegant evening gown",
    "in casual daily outfit",
    "in a tropical resort outfit",
    "in a chic blazer and skirt",
    "in a floral summer dress",
    "in a cozy oversized sweater",
    "in a stylish romper",
  ],
  // 场景
  scenes: [
    "amidst blooming cherry blossoms",
    "in a neon-lit city street at night",
    "by the ocean with waves in the background",
    "in a cozy cafe by the window",
    "in a lush garden full of flowers",
    "on a rooftop overlooking the skyline",
    "on a sandy beach at golden hour",
    "in a modern minimalist studio",
    "on a cobblestone street in old town",
    "in a sunlit park with greenery",
  ],
  // 姿态/动作
  poses: [
    "turning back to smile over her shoulder",
    "showing a graceful side profile",
    "captured mid-walk in candid motion",
    "gently tossing her hair back",
    "gazing into the distance with a soft smile",
    "laughing naturally with head slightly tilted",
    "standing confidently with hands on hips",
    "leaning casually against a wall",
    "adjusting her hair with one hand",
    "looking directly at the camera with a warm smile",
  ],
  // 光效
  lights: [
    "backlit with golden rim light",
    "soft side lighting",
    "golden hour warm sunlight",
    "neon glow lighting",
    "diffused soft daylight",
    "dramatic chiaroscuro lighting",
    "soft window light",
    "sunset backlight flare",
  ],
  // 色调
  tones: [
    "warm cinematic color grade",
    "soft pastel color palette",
    "moody blue-teal night tones",
    "bright and airy light tones",
    "vibrant and saturated colors",
    "vintage film color tones",
    "clean white and neutral tones",
    "dreamy warm golden tones",
  ],
  // 情绪/氛围
  moods: [
    "confident and empowering vibe",
    "gentle and tender atmosphere",
    "energetic and youthful mood",
    "elegant and refined atmosphere",
    "romantic and dreamy vibe",
    "playful and lively mood",
    "sophisticated and chic atmosphere",
    "fresh and natural vibe",
  ],
  // 附加随机元素 (可选)
  extras: [
    "with soft bokeh background",
    "with light flares in the frame",
    "with gentle wind blowing her hair",
    "with petals floating around",
    "with a shallow depth of field",
    "with reflections in a window",
    "with a blurred crowd in the background",
    "with sparkles of light in the air",
  ],
  // 负面提示词
  negative:
    "lowres, blurry, distorted face, deformed hands, extra fingers, bad anatomy, ugly, old, child, watermark, text, signature, cartoon, anime, 3d render, plastic skin, oversaturated, grainy, NSFW, nude, explicit",
};

// ──────────────────────────────────────────────────────
// 公共接口
// ──────────────────────────────────────────────────────

function buildJesusPrompt() {
  const subject = pick(JESUS.subjects);
  const scene = pick(JESUS.scenes);
  const pose = pick(JESUS.poses);
  const light = pick(JESUS.lights);
  const tone = pick(JESUS.tones);
  const mood = pick(JESUS.moods);
  // 50% 概率附加随机元素（0-2 个）
  const hasExtra = Math.random() < 0.6;
  const extras = hasExtra ? joinUnique(JESUS.extras, Math.floor(Math.random() * 2) + 1) : "";
  const core = [subject, pose, scene, light, tone, mood, extras].filter(Boolean).join(", ");
  return `${core}, ${QUALITY_SUFFIX}`;
}

function buildBeautyPrompt() {
  const subject = pick(BEAUTY.subjects);
  const style = pick(BEAUTY.styles);
  const outfit = pick(BEAUTY.outfits);
  const scene = pick(BEAUTY.scenes);
  const pose = pick(BEAUTY.poses);
  const light = pick(BEAUTY.lights);
  const tone = pick(BEAUTY.tones);
  const mood = pick(BEAUTY.moods);
  const hasExtra = Math.random() < 0.6;
  const extras = hasExtra ? joinUnique(BEAUTY.extras, Math.floor(Math.random() * 2) + 1) : "";
  const core = [subject, outfit, pose, scene, style, light, tone, mood, extras]
    .filter(Boolean)
    .join(", ");
  return `${core}, ${QUALITY_SUFFIX}`;
}

/**
 * 生成一个完整提示词
 * @param {"jesus"|"beauty"} category
 * @returns {string} 完整英文 prompt
 */
export function generatePrompt(category) {
  switch (category) {
    case "jesus":
      return buildJesusPrompt();
    case "beauty":
      return buildBeautyPrompt();
    default:
      throw new Error(`未知的提示词类别：${category}（支持 jesus / beauty）`);
  }
}

/**
 * 获取指定类别的负面提示词
 * @param {"jesus"|"beauty"} category
 * @returns {string}
 */
export function getNegativePrompt(category) {
  switch (category) {
    case "jesus":
      return JESUS.negative;
    case "beauty":
      return BEAUTY.negative;
    default:
      throw new Error(`未知的提示词类别：${category}（支持 jesus / beauty）`);
  }
}
