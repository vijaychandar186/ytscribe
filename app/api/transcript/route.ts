import { Innertube } from "youtubei.js";

export const runtime = "nodejs";
export const maxDuration = 30;

type CaptionTrack = {
  base_url: string;
  language_code: string;
  kind?: "asr" | "frc";
};

type Json3 = {
  events?: Array<{ segs?: Array<{ utf8?: string }> }>;
};

const YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v=";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      videoId: string;
      title?: string;
      url?: string;
      index?: number;
      language?: string;
    };

    const { videoId, title: inputTitle, index = 0, language = "en" } = body;
    const url = body.url || `${YOUTUBE_WATCH_URL}${videoId}`;

    if (!videoId) {
      return Response.json({ error: "videoId is required." }, { status: 400 });
    }

    const youtube = await Innertube.create({ retrieve_player: false });
    const info = await youtube.getBasicInfo(videoId, { client: "IOS" });
    const title = getTitle(info.basic_info?.title) || inputTitle || videoId;
    const tracks = (info.captions?.caption_tracks ?? []) as CaptionTrack[];
    const base = { id: videoId, title, url, index };

    if (!tracks.length) {
      return Response.json({ ...base, text: "", status: "missing", error: "This video has no captions." });
    }

    const track = pickTrack(tracks, language);

    if (!track) {
      return Response.json({ ...base, text: "", status: "missing", error: `No "${language}" captions available.` });
    }

    const text = await downloadAndParse(track.base_url);
    return Response.json({ ...base, text, status: text ? "ready" : "missing", error: text ? undefined : "Caption track was empty." });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch transcript." },
      { status: 500 }
    );
  }
}

function pickTrack(tracks: CaptionTrack[], language: string): CaptionTrack | undefined {
  const lang = language.toLowerCase();
  const matchesLang = (code: string) => {
    const c = code.toLowerCase();
    return c === lang || c.startsWith(`${lang}-`) || lang.startsWith(`${c}-`);
  };
  const exactManual = tracks.find((t) => matchesLang(t.language_code) && t.kind !== "asr");
  if (exactManual) return exactManual;
  const exactAuto = tracks.find((t) => matchesLang(t.language_code) && t.kind === "asr");
  if (exactAuto) return exactAuto;
  if (lang === "en") return tracks.find((t) => t.kind !== "asr") ?? tracks[0];
  return undefined;
}

async function downloadAndParse(baseUrl: string) {
  const url = baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Caption download failed: HTTP ${response.status}`);
  return parseJson3(await response.text());
}

function parseJson3(raw: string) {
  let data: Json3;
  try {
    data = JSON.parse(raw) as Json3;
  } catch {
    return "";
  }
  const text =
    data.events?.flatMap((e) => e.segs?.map((s) => s.utf8 || "") || []).join("") || "";
  return normalizeTranscript(text);
}

function normalizeTranscript(text: string) {
  return text
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.?!:;])/g, "$1")
    .trim();
}

function getTitle(title: unknown) {
  if (typeof title === "string") return title;
  if (title && typeof title === "object") {
    const c = title as { toString?: () => string; text?: string };
    return c.text || c.toString?.();
  }
  return undefined;
}
