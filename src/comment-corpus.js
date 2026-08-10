import { readFileSync } from "node:fs";

let corpus = null;
let corpusPath = null;

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had",
  "her", "was", "one", "our", "out", "day", "get", "has", "him", "his", "how",
  "its", "may", "new", "now", "old", "see", "two", "way", "who", "boy", "did",
  "let", "say", "she", "too", "use", "this", "that", "with", "have", "from",
  "they", "been", "were", "what", "when", "your", "them", "then", "some",
  "into", "very", "just", "like", "only", "over", "such", "than", "here",
  "most", "also", "made", "many", "more", "much", "must", "near", "need",
  "next", "back", "down", "each", "even", "every", "first", "found", "give",
  "gone", "good", "know", "last", "left", "life", "live", "look", "make",
  "never", "once", "open", "play", "said", "same", "seem", "show", "still",
  "take", "tell", "think", "time", "turn", "want", "well", "went", "will",
  "year", "yes", "about", "above", "after", "again", "being", "could",
  "doing", "other", "really", "would", "there", "these", "those", "where",
  "which", "while", "having", "should", "through", "before", "between",
  "because", "another", "doesn", "isn", "aren", "don", "didn", "won",
]);

function tokenize(text) {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

export function initCorpus(filePath) {
  corpusPath = filePath;
  try {
    corpus = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    corpus = [];
  }
  return corpus.length;
}

export function pickCommentFromCorpus(postContext, { randomFn = Math.random } = {}) {
  if (!corpus || corpus.length === 0) {
    if (corpusPath) {
      try {
        corpus = JSON.parse(readFileSync(corpusPath, "utf-8"));
      } catch {
        corpus = [];
      }
    }
    if (!corpus || corpus.length === 0) return null;
  }

  const { title, subreddit } = postContext;
  const titleTokens = tokenize(title || "");
  const sub = (subreddit || "").toLowerCase().replace(/^r\//, "");

  let candidates = corpus.filter((p) => p.subreddit === sub);
  if (candidates.length === 0) candidates = corpus;

  let bestPost = null;
  let bestScore = -1;
  for (const post of candidates) {
    const postTokens = tokenize(post.title);
    const sim = jaccardSimilarity(titleTokens, postTokens);
    if (sim > bestScore) {
      bestScore = sim;
      bestPost = post;
    }
  }

  if (!bestPost || !bestPost.comments || bestPost.comments.length === 0) return null;

  const sorted = [...bestPost.comments].sort((a, b) => (b.score || 0) - (a.score || 0));
  const topHalf = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 2)));
  const selected = topHalf[Math.floor(randomFn() * topHalf.length)];

  return {
    text: selected.text,
    matchedPost: bestPost.title.substring(0, 80),
    similarity: Math.round(bestScore * 100) / 100,
    subreddit: bestPost.subreddit,
    commentScore: selected.score || 0,
  };
}
