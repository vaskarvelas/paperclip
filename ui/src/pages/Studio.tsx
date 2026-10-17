import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  FolderOpen,
  Layers,
  Mic,
  Palette,
  Film,
  Compass,
  Send,
  Sparkles,
} from "lucide-react";
import type {
  StudioCategoryFilter,
  StudioChoiceOption,
  StudioPageCategory,
  StudioPageItem,
  StudioSelectionStatus,
} from "@paperclipai/shared";
import { studioApi } from "../api/studio";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { AgentAvatar } from "../components/AgentAvatar";
import { MarkdownBody } from "../components/MarkdownBody";
import { Link, useNavigate, useParams } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const SELECTION_PRESENTATION: Record<StudioSelectionStatus, { label: string; tone: string }> = {
  awaiting_choice: { label: "Awaiting choice", tone: "warning" },
  choice_made: { label: "Choice saved", tone: "succeeded" },
  reference: { label: "Reference", tone: "archived" },
};

const CATEGORY_LABELS: Record<StudioPageCategory, string> = {
  voices_sound: "Voices & Sound",
  art_mascots: "Art Styles & Mascots",
  episodes: "Episodes & Hooks",
  decisions: "Design Decisions",
  other: "Other",
};

const CATEGORY_TABS: {
  value: StudioCategoryFilter;
  label: string;
  countOf?: StudioPageCategory;
  icon: typeof Layers;
}[] = [
  { value: "all", label: "All Studio Pages", icon: Layers },
  { value: "voices_sound", label: "Voices & Sound", countOf: "voices_sound", icon: Mic },
  { value: "art_mascots", label: "Art Styles & Mascots", countOf: "art_mascots", icon: Palette },
  { value: "episodes", label: "Episodes & Hooks", countOf: "episodes", icon: Film },
  { value: "decisions", label: "Design Decisions", countOf: "decisions", icon: Compass },
];

export function Studio() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pageId } = useParams<{ pageId?: string }>();
  const navigate = useNavigate();
  const [category, setCategory] = useState<StudioCategoryFilter>("all");

  const listQuery = useQuery({
    queryKey: queryKeys.studio.list(selectedCompanyId ?? "", category),
    queryFn: () => studioApi.list(selectedCompanyId!, category),
    enabled: Boolean(selectedCompanyId),
  });

  const pages = listQuery.data?.pages ?? [];
  const activePage = pages.find((item) => item.id === pageId || item.slug === pageId) ?? pages[0] ?? null;

  useEffect(() => {
    setBreadcrumbs(
      activePage
        ? [{ label: "Studio", href: "/studio" }, { label: activePage.title }]
        : [{ label: "Studio" }],
    );
  }, [setBreadcrumbs, activePage]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Palette} message="Select a company to open its Studio." />;
  }

  const counts = listQuery.data?.counts;
  const studioRootDir = listQuery.data?.studioRootDir;

  return (
    <div className="w-full max-w-7xl space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold">Studio</h1>
          <p className="text-sm text-muted-foreground">
            Persistent showroom for voices, sound effects, art styles, mascot identities, episode gates, and design decisions. Pick your choices here and Paperclip saves them for every agent.
          </p>
        </div>
        {studioRootDir ? (
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-mono">{studioRootDir}</span>
          </div>
        ) : null}
      </header>

      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Studio categories">
        {CATEGORY_TABS.map((tab) => {
          const count = tab.countOf ? counts?.[tab.countOf] ?? 0 : null;
          const active = category === tab.value;
          const Icon = tab.icon;
          return (
            <Button
              key={tab.value}
              role="tab"
              aria-selected={active}
              variant={active ? "secondary" : "ghost"}
              size="sm"
              onClick={() => {
                setCategory(tab.value);
                if (pageId) navigate("/studio");
              }}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
              {count !== null && count > 0 ? <Badge variant="outline">{count}</Badge> : null}
            </Button>
          );
        })}
      </div>

      {listQuery.error ? (
        <p className="text-sm text-destructive">Could not load Studio pages: {(listQuery.error as Error).message}</p>
      ) : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <section className={cn("min-w-0 space-y-2 lg:col-span-4", pageId && "hidden lg:block")} aria-label="Studio pages">
          {listQuery.isPending ? (
            <PageSkeleton variant="list" />
          ) : pages.length === 0 ? (
            <EmptyState
              icon={Palette}
              title="No Studio pages in this category"
              message="Agents publish persistent comparison pages (voices, art styles, mascots, episode gates) to Studio so you can compare and choose anytime."
            />
          ) : (
            pages.map((item) => (
              <StudioListItem
                key={item.id}
                page={item}
                selected={activePage?.id === item.id}
              />
            ))
          )}
        </section>

        <section className={cn("min-w-0 lg:col-span-8", !activePage && "hidden lg:block")} aria-label="Studio page detail">
          {!activePage ? (
            <EmptyState icon={Palette} message="Select a Studio page to audition samples and record your choice." />
          ) : (
            <StudioPageDetail key={activePage.id} page={activePage} />
          )}
        </section>
      </div>
    </div>
  );
}

function StudioListItem({ page, selected }: { page: StudioPageItem; selected: boolean }) {
  const presentation = SELECTION_PRESENTATION[page.selectionStatus];
  return (
    <Link
      to={`/studio/${page.id}`}
      data-testid="studio-list-item"
      className={cn(
        "block space-y-2 rounded-lg border p-3 transition-colors hover:bg-accent/50",
        selected ? "border-primary bg-accent/40" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={presentation.tone} label={presentation.label} />
        <Badge variant="outline">{CATEGORY_LABELS[page.category]}</Badge>
      </div>
      <p className="line-clamp-2 text-sm font-medium">{page.title}</p>
      {page.selectedChoices.length > 0 ? (
        <p className="line-clamp-2 text-xs font-medium text-foreground">
          Chosen: {page.selectedChoices.join(" · ")}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {page.agent ? (
          <>
            <AgentAvatar agent={page.agent} name={page.agent.name} size={16} />
            <span className="truncate">{page.agent.name}</span>
          </>
        ) : null}
        {page.issue?.identifier ? <span className="shrink-0 font-mono">{page.issue.identifier}</span> : null}
        <span className="ml-auto shrink-0">{relativeTime(page.updatedAt)}</span>
      </div>
    </Link>
  );
}

function StudioPageDetail({ page }: { page: StudioPageItem }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [selectedChoices, setSelectedChoices] = useState<string[]>(page.selectedChoices);
  const [choiceNotes, setChoiceNotes] = useState<string>(page.choiceNotes ?? "");
  const presentation = SELECTION_PRESENTATION[page.selectionStatus];
  const agentName = page.agent?.name ?? "the responsible agent";

  useEffect(() => {
    setSelectedChoices(page.selectedChoices);
    setChoiceNotes(page.choiceNotes ?? "");
  }, [page.id, page.updatedAt, page.selectedChoices, page.choiceNotes]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const payload = event.data as {
        type?: string;
        text?: string;
        data?: { sampleIds?: string[]; answer?: string; notes?: string; question?: string } | null;
      } | null;
      if (!payload || payload.type !== "paperclip:lavish-prompt") return;
      const incomingIds = Array.isArray(payload.data?.sampleIds)
        ? payload.data!.sampleIds.map(String)
        : payload.data?.answer
          ? [String(payload.data.answer)]
          : payload.text
            ? [String(payload.text)]
            : [];
      if (incomingIds.length > 0) {
        setSelectedChoices((prev) => [...new Set([...prev, ...incomingIds])]);
      }
      if (payload.data?.notes) {
        setChoiceNotes((prev) => (prev ? `${prev}\n${payload.data!.notes}` : String(payload.data!.notes)));
      }
      pushToast({
        title: "Selection captured from page",
        body: "Click 'Save Choice & Wake Agent' above to persist your decision.",
        tone: "success",
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pushToast]);

  const saveChoice = useMutation({
    mutationFn: (notifyAgent: boolean) =>
      studioApi.updateChoice(page.id, {
        selectedChoices,
        choiceNotes: choiceNotes.trim() || null,
        selectionStatus:
          selectedChoices.length > 0 || choiceNotes.trim()
            ? "choice_made"
            : page.selectionStatus === "reference"
              ? "reference"
              : "awaiting_choice",
        notifyAgent,
      }),
    onSuccess: (next, notifyAgent) => {
      queryClient.setQueryData(queryKeys.studio.detail(page.companyId, page.id), next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.studio.all(page.companyId) });
      pushToast({
        title: "Studio choice saved",
        body: notifyAgent && page.agent
          ? `Saved to Studio and woke ${agentName} with your choice.`
          : "Saved to the shared Studio choices manifest.",
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: "Could not save Studio choice",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      }),
  });

  const toggleChoice = (labelOrId: string) => {
    setSelectedChoices((prev) =>
      prev.includes(labelOrId) ? prev.filter((item) => item !== labelOrId) : [...prev, labelOrId],
    );
  };

  const groupedChoices: Record<string, StudioChoiceOption[]> = {};
  for (const option of page.choices) {
    const groupName = option.group?.trim() || "Available Options";
    if (!groupedChoices[groupName]) groupedChoices[groupName] = [];
    groupedChoices[groupName]!.push(option);
  }

  const previewSrc = page.contentUrl ? `${page.contentUrl}?v=${encodeURIComponent(page.updatedAt)}` : null;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    saveChoice.mutate(Boolean(page.agent));
  };

  return (
    <article className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <Button variant="ghost" size="xs" className="lg:hidden" onClick={() => navigate("/studio")}>
            <ArrowLeft /> All Studio pages
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={presentation.tone} label={presentation.label} />
            <Badge variant="outline">{CATEGORY_LABELS[page.category]}</Badge>
            <Badge variant="outline" className="font-mono">{page.slug}</Badge>
          </div>
          <h2 className="text-lg font-semibold">{page.title}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {page.agent ? (
              <>
                <AgentAvatar agent={page.agent} name={page.agent.name} size={16} />
                <span>{page.agent.name}</span>
              </>
            ) : null}
            {page.issue?.identifier ? (
              <Link to={`/issues/${page.issue.identifier}`} className="font-mono hover:underline">
                {page.issue.identifier}
              </Link>
            ) : null}
            {page.reviewId ? (
              <Link to={`/reviews/${page.reviewId}`} className="hover:underline">
                Linked review
              </Link>
            ) : null}
            <span>· updated {relativeTime(page.updatedAt)}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {page.externalUrl ? (
            <Button asChild size="sm" variant="outline">
              <a href={page.externalUrl} target="_blank" rel="noreferrer">
                Open Live Workbench <ExternalLink />
              </a>
            </Button>
          ) : null}
          {page.lavishSessionUrl ? (
            <Button asChild size="sm" variant="outline">
              <a href={page.lavishSessionUrl} target="_blank" rel="noreferrer">
                <Sparkles /> Open in Lavish <ExternalLink />
              </a>
            </Button>
          ) : null}
          {previewSrc ? (
            <Button asChild size="sm" variant="ghost">
              <a href={previewSrc} target="_blank" rel="noreferrer">
                Full tab <ExternalLink />
              </a>
            </Button>
          ) : null}
        </div>
      </div>

      {page.summary ? (
        <div className="rounded-lg border border-border p-3 text-sm">
          <MarkdownBody>{page.summary}</MarkdownBody>
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="Studio choice selector">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <h3 className="text-sm font-semibold">Your Persistent Choice</h3>
            <p className="text-xs text-muted-foreground">
              Click options below (or use controls inside the page) to pick your preferred voices, art styles, or production gate.
            </p>
          </div>
          {selectedChoices.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setSelectedChoices([])}
            >
              Clear ({selectedChoices.length})
            </Button>
          ) : null}
        </div>

        {Object.entries(groupedChoices).map(([groupName, options]) => (
          <div key={groupName} className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{groupName}</p>
            <div className="flex flex-wrap gap-1.5">
              {options.map((option) => {
                const value = option.label;
                const active = selectedChoices.includes(value) || selectedChoices.includes(option.id);
                return (
                  <Button
                    key={option.id}
                    type="button"
                    size="xs"
                    variant={active ? "default" : "outline"}
                    aria-pressed={active}
                    title={option.description ?? undefined}
                    onClick={() => toggleChoice(value)}
                  >
                    {active ? <Check className="h-3 w-3" /> : null}
                    {option.label}
                  </Button>
                );
              })}
            </div>
          </div>
        ))}

        {selectedChoices.length > 0 ? (
          <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
            <span className="font-semibold">Selected: </span>
            <span>{selectedChoices.join(" · ")}</span>
          </div>
        ) : null}

        <Textarea
          value={choiceNotes}
          onChange={(event) => setChoiceNotes(event.target.value)}
          placeholder={`Optional notes or direction for ${agentName} (e.g., "Use af_heart for narration, keep Corvid A & Lamp D for final test")…`}
          rows={2}
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {page.chosenAt ? `Last saved ${relativeTime(page.chosenAt)}` : "No choice saved yet"}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {page.agent ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saveChoice.isPending}
                onClick={() => saveChoice.mutate(false)}
              >
                Save only
              </Button>
            ) : null}
            <Button type="submit" size="sm" disabled={saveChoice.isPending}>
              <Send /> {page.agent ? `Save Choice & Wake ${page.agent.name}` : "Save Choice"}
            </Button>
          </div>
        </div>
      </form>

      {previewSrc ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="truncate font-mono">{page.filePath}</span>
            <a href={previewSrc} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 hover:text-foreground">
              Open in new tab <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <iframe
            ref={iframeRef}
            key={previewSrc}
            title={`${page.title} preview`}
            src={previewSrc}
            sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            referrerPolicy="no-referrer"
            className="block h-svh max-h-screen w-full border-0 bg-background"
          />
        </div>
      ) : null}
    </article>
  );
}
