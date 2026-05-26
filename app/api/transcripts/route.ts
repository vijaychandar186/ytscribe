import { Innertube } from "youtubei.js";

export const runtime = "nodejs";
export const maxDuration = 60;

type PlaylistVideo = {
  id: string;
  title: string;
  url: string;
};

type TranscriptItem = PlaylistVideo & {
  index: number;
  text: string;
  status: "ready" | "missing" | "error";
  error?: string;
};

type CaptionTrack = {
  base_url: string;
  language_code: string;
  kind?: "asr" | "frc";
  name?: { toString?: () => string; text?: string };
};

type Json3 = {
  events?: Array<{ segs?: Array<{ utf8?: string }> }>;
};

const YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v=";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { url?: string; language?: string };
    const url = body.url?.trim();
    const language = body.language?.trim() || "en";

    if (!url) {
      return Response.json({ error: "Paste a YouTube video or playlist URL." }, { status: 400 });
    }

    const youtube = await Innertube.create({ retrieve_player: false });
    const videos = await getVideos(youtube, url);

    if (!videos.length) {
      return Response.json({ error: "No videos were found for that URL." }, { status: 400 });
    }

    const items = await mapWithConcurrency(videos, 3, async (video, itemIndex) => {
      return fetchTranscript(youtube, video, itemIndex + 1, language);
    });

    const mergedText = items
      .filter((item) => item.text)
      .map((item) => `# ${item.index}. ${item.title}\n${item.url}\n\n${item.text}`)
      .join("\n\n");

    return Response.json({
      count: items.length,
      readyCount: items.filter((item) => item.status === "ready").length,
      mergedText,
      items,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch transcripts." },
      { status: 500 }
    );
  }
}

async function getVideos(youtube: Innertube, input: string): Promise<PlaylistVideo[]> {
  const parsedUrl = new URL(input);
  const playlistId = parsedUrl.searchParams.get("list");
  const videoId = getVideoId(parsedUrl);

  if (!playlistId) {
    if (!videoId) {
      throw new Error("Use a valid YouTube video or playlist URL.");
    }

    return [
      {
        id: videoId,
        title: videoId,
        url: `${YOUTUBE_WATCH_URL}${videoId}`,
      },
    ];
  }

  let playlist = await youtube.getPlaylist(playlistId);
  const videos: PlaylistVideo[] = [];

  while (true) {
    for (const item of playlist.items) {
      const candidate = item as unknown as {
        id?: string;
        title?: { toString?: () => string; text?: string } | string;
        is_playable?: boolean;
      };

      if (!candidate.id || candidate.is_playable === false) {
        continue;
      }

      videos.push({
        id: candidate.id,
        title: getTitle(candidate.title) || candidate.id,
        url: `${YOUTUBE_WATCH_URL}${candidate.id}`,
      });
    }

    if (!playlist.has_continuation) {
      break;
    }

    playlist = await playlist.getContinuation();
  }

  return dedupeVideos(videos);
}

async function fetchTranscript(
  youtube: Innertube,
  video: PlaylistVideo,
  index: number,
  language: string
): Promise<TranscriptItem> {
  try {
    const info = await youtube.getBasicInfo(video.id, { client: "IOS" });
    const title = getTitle(info.basic_info?.title) || video.title;
    const tracks = (info.captions?.caption_tracks ?? []) as CaptionTrack[];

    if (!tracks.length) {
      return {
        ...video,
        title,
        index,
        text: "",
        status: "missing",
        error: "This video has no captions.",
      };
    }

    const track = pickTrack(tracks, language);

    if (!track) {
      return {
        ...video,
        title,
        index,
        text: "",
        status: "missing",
        error: `No "${language}" captions available.`,
      };
    }

    const text = await downloadAndParse(track.base_url);

    return {
      ...video,
      title,
      index,
      text,
      status: text ? "ready" : "missing",
      error: text ? undefined : "Caption track was empty.",
    };
  } catch (error) {
    return {
      ...video,
      index,
      text: "",
      status: "error",
      error: cleanError(error),
    };
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

  if (lang === "en") {
    return tracks.find((t) => t.kind !== "asr") ?? tracks[0];
  }

  return undefined;
}

async function downloadAndParse(baseUrl: string) {
  const url = baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Caption download failed: HTTP ${response.status}`);
  }

  const raw = await response.text();
  return parseJson3(raw);
}

function parseJson3(raw: string) {
  let data: Json3;
  try {
    data = JSON.parse(raw) as Json3;
  } catch {
    return "";
  }

  const text =
    data.events
      ?.flatMap((event) => event.segs?.map((segment) => segment.utf8 || "") || [])
      .join("") || "";

  return normalizeTranscript(text);
}

function normalizeTranscript(text: string) {
  return text
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.?!:;])/g, "$1")
    .trim();
}

function getVideoId(url: URL) {
  if (url.hostname.includes("youtu.be")) {
    return url.pathname.split("/").filter(Boolean)[0];
  }

  if (url.pathname === "/watch") {
    return url.searchParams.get("v") || undefined;
  }

  if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
    return url.pathname.split("/").filter(Boolean)[1];
  }

  return undefined;
}

function getTitle(title: unknown) {
  if (typeof title === "string") {
    return title;
  }

  if (title && typeof title === "object") {
    const candidate = title as { toString?: () => string; text?: string };
    return candidate.text || candidate.toString?.();
  }

  return undefined;
}

function dedupeVideos(videos: PlaylistVideo[]) {
  const seen = new Set<string>();

  return videos.filter((video) => {
    if (seen.has(video.id)) {
      return false;
    }

    seen.add(video.id);
    return true;
  });
}

function cleanError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Transcript fetch failed.";

  return message.replace(/\s+/g, " ").trim();
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );

  return results;
}
