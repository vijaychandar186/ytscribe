import { Innertube } from "youtubei.js";

export const runtime = "nodejs";
export const maxDuration = 60;

type Video = { id: string; title: string; url: string };

const YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v=";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { url?: string };
    const url = body.url?.trim();

    if (!url) {
      return Response.json({ error: "Paste a YouTube video or playlist URL." }, { status: 400 });
    }

    const youtube = await Innertube.create({ retrieve_player: false });
    const videos = await getVideos(youtube, url);

    if (!videos.length) {
      return Response.json({ error: "No videos were found for that URL." }, { status: 400 });
    }

    return Response.json({ count: videos.length, videos });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch playlist." },
      { status: 500 }
    );
  }
}

async function getVideos(youtube: Innertube, input: string): Promise<Video[]> {
  const parsedUrl = new URL(input);
  const playlistId = parsedUrl.searchParams.get("list");
  const videoId = getVideoId(parsedUrl);

  if (!playlistId) {
    if (!videoId) throw new Error("Use a valid YouTube video or playlist URL.");
    return [{ id: videoId, title: videoId, url: `${YOUTUBE_WATCH_URL}${videoId}` }];
  }

  let playlist = await youtube.getPlaylist(playlistId);
  const videos: Video[] = [];

  while (true) {
    for (const item of playlist.items) {
      const candidate = item as unknown as {
        id?: string;
        title?: { toString?: () => string; text?: string } | string;
        is_playable?: boolean;
      };
      if (!candidate.id || candidate.is_playable === false) continue;
      videos.push({
        id: candidate.id,
        title: getTitle(candidate.title) || candidate.id,
        url: `${YOUTUBE_WATCH_URL}${candidate.id}`,
      });
    }
    if (!playlist.has_continuation) break;
    playlist = await playlist.getContinuation();
  }

  return dedupeVideos(videos);
}

function getVideoId(url: URL) {
  if (url.hostname.includes("youtu.be")) return url.pathname.split("/").filter(Boolean)[0];
  if (url.pathname === "/watch") return url.searchParams.get("v") || undefined;
  if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/"))
    return url.pathname.split("/").filter(Boolean)[1];
  return undefined;
}

function getTitle(title: unknown) {
  if (typeof title === "string") return title;
  if (title && typeof title === "object") {
    const c = title as { toString?: () => string; text?: string };
    return c.text || c.toString?.();
  }
  return undefined;
}

function dedupeVideos(videos: Video[]) {
  const seen = new Set<string>();
  return videos.filter((v) => {
    if (seen.has(v.id)) return false;
    seen.add(v.id);
    return true;
  });
}
