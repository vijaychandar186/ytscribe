import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Innertube } from "youtubei.js";
import youtubedl from "youtube-dl-exec";

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

const YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v=";

export async function POST(request: Request) {
  let workDir: string | undefined;

  try {
    const body = (await request.json()) as {
      url?: string;
      language?: string;
      cookies?: string;
    };
    const url = body.url?.trim();
    const language = body.language?.trim() || "en";
    const cookies = body.cookies?.trim();

    if (!url) {
      return Response.json({ error: "Paste a YouTube video or playlist URL." }, { status: 400 });
    }

    const videos = await getVideos(url);

    if (!videos.length) {
      return Response.json({ error: "No videos were found for that URL." }, { status: 400 });
    }

    workDir = await mkdtemp(path.join(tmpdir(), "yt-transcripts-"));
    const cookieFile = await createCookieFile(workDir, cookies);
    const items = await mapWithConcurrency(videos, 2, async (video, itemIndex) => {
      return fetchTranscript(video, itemIndex + 1, language, workDir!, cookieFile);
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
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

async function getVideos(input: string): Promise<PlaylistVideo[]> {
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

  const youtube = await Innertube.create({ retrieve_player: false });
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
  video: PlaylistVideo,
  index: number,
  language: string,
  workDir: string,
  cookieFile?: string
): Promise<TranscriptItem> {
  const output = path.join(workDir, `${String(index).padStart(3, "0")} - %(title).180B.%(ext)s`);

  try {
    await youtubedl(video.url, {
      skipDownload: true,
      writeSub: true,
      writeAutoSub: true,
      subLang: language,
      subFormat: "json3/vtt/srv3/best",
      noPlaylist: true,
      noWarnings: true,
      noProgress: true,
      output,
      ...(cookieFile ? { cookies: cookieFile } : {}),
    });

    const filePath = await findSubtitleFile(workDir, index);

    if (!filePath) {
      return {
        ...video,
        index,
        text: "",
        status: "missing",
        error: "No English transcript was found.",
      };
    }

    const raw = await readFile(filePath, "utf8");
    const text = subtitleToText(raw, path.extname(filePath));

    return {
      ...video,
      index,
      text,
      status: text ? "ready" : "missing",
      error: text ? undefined : "The subtitle file was empty.",
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

async function findSubtitleFile(workDir: string, index: number) {
  const prefix = `${String(index).padStart(3, "0")} - `;
  const files = await readdir(workDir);
  const candidates = files
    .filter((file) => file.startsWith(prefix))
    .filter((file) => [".json3", ".vtt", ".srv3", ".srt"].includes(path.extname(file)))
    .sort((a, b) => scoreSubtitleFile(a) - scoreSubtitleFile(b));

  return candidates[0] ? path.join(workDir, candidates[0]) : undefined;
}

function subtitleToText(raw: string, extension: string) {
  if (extension === ".json3") {
    const data = JSON.parse(raw) as {
      events?: Array<{ segs?: Array<{ utf8?: string }> }>;
    };

    return normalizeTranscript(
      data.events
        ?.flatMap((event) => event.segs?.map((segment) => segment.utf8 || "") || [])
        .join("") || ""
    );
  }

  return normalizeTranscript(
    raw
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return (
          trimmed &&
          trimmed !== "WEBVTT" &&
          !trimmed.includes("-->") &&
          !/^\d+$/.test(trimmed) &&
          !trimmed.startsWith("Kind:") &&
          !trimmed.startsWith("Language:")
        );
      })
      .join(" ")
      .replace(/<[^>]+>/g, " ")
  );
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

function getTitle(title: PlaylistVideo["title"] | unknown) {
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

async function createCookieFile(workDir: string, override?: string) {
  const cookies = override?.trim() || process.env.YOUTUBE_COOKIES?.trim();

  if (!cookies) {
    return undefined;
  }

  const cookieFile = path.join(workDir, "youtube-cookies.txt");
  await writeFile(cookieFile, cookies);
  return cookieFile;
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

function scoreSubtitleFile(file: string) {
  const extension = path.extname(file);
  return [".json3", ".vtt", ".srv3", ".srt"].indexOf(extension);
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