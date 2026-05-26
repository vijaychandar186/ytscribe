"use client";

import { useEffect, useMemo, useState } from "react";

import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";

type TranscriptItem = {
  id: string;
  title: string;
  url: string;
  index: number;
  text: string;
  status: "pending" | "ready" | "missing" | "error";
  error?: string;
};

type TranscriptData = {
  count: number;
  readyCount: number;
  mergedText: string;
  items: TranscriptItem[];
};

const exampleUrl =
  "https://youtube.com/playlist?list=PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab";

const STORAGE_KEY = "transcript-extractor:v1";

type PersistedState = {
  url: string;
  language: string;
  data: TranscriptData | null;
};

export function TranscriptClient() {
  const [url, setUrl] = useState(exampleUrl);
  const [language, setLanguage] = useState("en");
  const [data, setData] = useState<TranscriptData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedState;
        if (parsed.url) setUrl(parsed.url);
        if (parsed.language) setLanguage(parsed.language);
        if (parsed.data) setData(parsed.data);
      }
    } catch {
      // ignore corrupt storage
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ url, language, data })
      );
    } catch {
      // quota / private mode — fail quietly
    }
  }, [url, language, data, hydrated]);

  const summary = useMemo(() => {
    if (!data) return "Paste a YouTube URL and fetch transcript text.";
    const pending = data.items.filter((i) => i.status === "pending").length;
    if (pending > 0) return `Fetching ${pending} remaining of ${data.count}…`;
    return `${data.readyCount} of ${data.count} transcripts ready`;
  }, [data]);

  async function fetchTranscripts(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setCopied("");
    setLoading(true);
    setData(null);

    try {
      // Phase 1: resolve playlist → video list (cheap, ~2 subrequests)
      const listRes = await fetch("/api/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const listPayload = (await listRes.json()) as {
        count: number;
        videos: { id: string; title: string; url: string }[];
        error?: string;
      };

      if (!listRes.ok) {
        throw new Error(listPayload.error || "Failed to fetch playlist.");
      }

      const lang = language.trim() || "en";

      // Show cards immediately with pending placeholders
      const pendingItems: TranscriptItem[] = listPayload.videos.map((v, i) => ({
        ...v,
        index: i + 1,
        text: "",
        status: "pending",
      }));

      setData({ count: listPayload.count, readyCount: 0, mergedText: "", items: pendingItems });

      // Phase 2: fetch each transcript individually (2–3 subrequests each, separate invocations)
      await Promise.all(
        listPayload.videos.map(async (video, i) => {
          let result: TranscriptItem;
          try {
            const res = await fetch("/api/transcript", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ videoId: video.id, title: video.title, url: video.url, index: i + 1, language: lang }),
            });
            const payload = (await res.json()) as TranscriptItem & { error?: string };
            if (!res.ok) throw new Error(payload.error || "Failed.");
            result = payload;
          } catch (err) {
            result = {
              ...video,
              index: i + 1,
              text: "",
              status: "error",
              error: err instanceof Error ? err.message : "Failed to fetch transcript.",
            };
          }

          setData((prev) => {
            if (!prev) return prev;
            const items = prev.items.map((it) => (it.id === video.id ? result : it));
            const readyCount = items.filter((it) => it.status === "ready").length;
            const mergedText = items
              .filter((it) => it.status === "ready" && it.text)
              .map((it) => `# ${it.index}. ${it.title}\n${it.url}\n\n${it.text}`)
              .join("\n\n");
            return { ...prev, items, readyCount, mergedText };
          });
        })
      );
    } catch (caughtError) {
      setData(null);
      setError(caughtError instanceof Error ? caughtError.message : "Failed to fetch transcripts.");
    } finally {
      setLoading(false);
    }
  }

  async function copyText(label: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    window.setTimeout(() => {
      setCopied((current) => (current === label ? "" : current));
    }, 1500);
  }

  function CopyButton({ label, text }: { label: string; text: string }) {
    const isCopied = copied === label;
    return (
      <Button
        type="button"
        variant="outline"
        size="icon"
        disabled={!text}
        aria-label={isCopied ? `Copied ${label}` : `Copy ${label}`}
        onClick={() => copyText(label, text)}
      >
        <HugeiconsIcon icon={isCopied ? Tick02Icon : Copy01Icon} size={16} />
      </Button>
    );
  }

  return (
    <main className="min-h-full bg-background px-4 py-6 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <section className="flex flex-col gap-4 py-4">
          <div className="flex flex-col gap-2">
            <Badge variant="outline" className="w-fit">
              Transcript extractor
            </Badge>
            <h1 className="max-w-3xl text-3xl font-semibold tracking-normal sm:text-4xl">
              YouTube transcripts as copy-ready text
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              Fetch English subtitles only, then copy each transcript or one merged version.
            </p>
          </div>
        </section>

        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>Source</CardTitle>
            <CardDescription>{summary}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={fetchTranscripts} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="youtube-url">YouTube URL</Label>
                <Input
                  id="youtube-url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://youtube.com/playlist?list=..."
                  disabled={loading}
                />
              </div>

              <details className="group rounded-lg border border-input bg-input/20 px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium text-muted-foreground select-none">
                  Options (optional)
                </summary>
                <div className="mt-3 flex flex-col gap-2">
                  <Label htmlFor="sub-language">Subtitle language</Label>
                  <Input
                    id="sub-language"
                    value={language}
                    onChange={(event) => setLanguage(event.target.value)}
                    placeholder="en"
                    disabled={loading}
                    className="max-w-32"
                  />
                  <p className="text-xs text-muted-foreground">
                    ISO code, e.g. <code>en</code>, <code>es</code>, <code>ja</code>. Defaults to English.
                  </p>
                </div>
              </details>

              <Button
                type="submit"
                disabled={loading || !url.trim()}
                className="w-fit"
              >
                {loading ? (
                  <>
                    <Spinner />
                    Fetching...
                  </>
                ) : (
                  "Fetch transcripts"
                )}
              </Button>
            </form>

            {error ? (
              <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {data ? (
          <div className="flex flex-col gap-6">
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle>Merged Transcript</CardTitle>
                <CardDescription>Everything appended in order.</CardDescription>
                <CardAction>
                  <CopyButton label="merged transcript" text={data.mergedText} />
                </CardAction>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[420px] w-full rounded-xl border border-input bg-input/30">
                  <pre className="whitespace-pre-wrap px-3 py-3 font-mono text-sm leading-6">
                    {data.mergedText || "Transcripts loading…"}
                  </pre>
                </ScrollArea>
              </CardContent>
            </Card>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.items.map((item) => (
                <Card key={item.id} className="flex flex-col rounded-lg">
                  <CardHeader>
                    <CardTitle className="text-sm leading-snug">
                      {item.index}. {item.title}
                    </CardTitle>
                    <CardDescription className="text-xs">
                      {item.status === "pending"
                        ? "Fetching…"
                        : item.status === "ready"
                          ? `${item.text.length.toLocaleString()} characters`
                          : item.error || "Transcript unavailable"}
                    </CardDescription>
                    <CardAction>
                      <CopyButton label={item.title} text={item.text} />
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <ScrollArea className="h-48 w-full rounded-xl border border-input bg-input/30">
                      <pre className="whitespace-pre-wrap px-3 py-3 text-sm leading-6">
                        {item.status === "pending" ? "Loading…" : item.text || item.error || ""}
                      </pre>
                    </ScrollArea>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
