import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ClipboardCheck,
  ExternalLink,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import type {
  ReviewItem,
  ReviewItemDetail,
  ReviewItemStatus,
  ReviewListStatusFilter,
  ReviewMessage,
} from "@paperclipai/shared";
import { reviewsApi } from "../api/reviews";
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

/** Status chips reuse the shared status palette so the vocabulary stays systematic. */
const STATUS_PRESENTATION: Record<ReviewItemStatus, { label: string; tone: string }> = {
  pending_review: { label: "Needs review", tone: "warning" },
  changes_requested: { label: "Agent working", tone: "running" },
  approved: { label: "Approved", tone: "succeeded" },
  closed: { label: "Closed", tone: "archived" },
};

const FILTERS: { value: ReviewListStatusFilter; label: string; countOf?: ReviewItemStatus }[] = [
  { value: "pending_review", label: "Needs review", countOf: "pending_review" },
  { value: "changes_requested", label: "Agent working", countOf: "changes_requested" },
  { value: "approved", label: "Approved", countOf: "approved" },
  { value: "closed", label: "Closed", countOf: "closed" },
  { value: "all", label: "All" },
];

function ReviewStatusBadge({ status }: { status: ReviewItemStatus }) {
  const presentation = STATUS_PRESENTATION[status];
  return <StatusBadge status={presentation.tone} label={presentation.label} />;
}

export function Reviews() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { reviewId } = useParams<{ reviewId?: string }>();
  const [filter, setFilter] = useState<ReviewListStatusFilter>("pending_review");
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const listQuery = useQuery({
    queryKey: queryKeys.reviews.list(selectedCompanyId ?? "", filter),
    queryFn: () => reviewsApi.list(selectedCompanyId!, filter),
    enabled: Boolean(selectedCompanyId),
  });
  const detailQuery = useQuery({
    queryKey: queryKeys.reviews.detail(selectedCompanyId ?? "", reviewId ?? ""),
    queryFn: () => reviewsApi.get(reviewId!),
    enabled: Boolean(selectedCompanyId && reviewId),
  });

  const pollNow = useMutation({
    mutationFn: () => reviewsApi.pollNow(selectedCompanyId!),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reviews.all(selectedCompanyId!) });
      pushToast({
        title: result.feedbackBatches > 0 ? "New Lavish feedback routed to agents" : "Lavish checked",
        body: `${result.polled} session(s) polled · ${result.feedbackBatches} feedback batch(es) · ${result.repliesDelivered} repl(ies) delivered${result.errors ? ` · ${result.errors} error(s)` : ""}`,
        tone: result.errors ? "warn" : "success",
      });
    },
    onError: (error) => pushToast({ title: "Lavish check failed", body: error instanceof Error ? error.message : String(error), tone: "error" }),
  });

  const detail = detailQuery.data;
  useEffect(() => {
    setBreadcrumbs(detail
      ? [{ label: "Reviews", href: "/reviews" }, { label: detail.title }]
      : [{ label: "Reviews" }]);
  }, [setBreadcrumbs, detail]);

  if (!selectedCompanyId) {
    return <EmptyState icon={ClipboardCheck} message="Select a company to see its reviews." />;
  }

  const counts = listQuery.data?.counts;
  const reviews = listQuery.data?.reviews ?? [];

  return (
    <div className="w-full max-w-7xl space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold">Reviews</h1>
          <p className="text-sm text-muted-foreground">
            Results, samples and questions your agents need you to look at. Feedback goes straight back to the responsible agent.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => pollNow.mutate()} disabled={pollNow.isPending}>
          <RefreshCw className={cn("h-4 w-4", pollNow.isPending && "animate-spin")} />
          Check Lavish now
        </Button>
      </header>

      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Review status">
        {FILTERS.map((option) => {
          const count = option.countOf ? counts?.[option.countOf] ?? 0 : null;
          const active = filter === option.value;
          return (
            <Button
              key={option.value}
              role="tab"
              aria-selected={active}
              variant={active ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setFilter(option.value)}
            >
              {option.label}
              {count !== null && count > 0 ? (
                <Badge variant={option.value === "pending_review" ? "default" : "outline"}>{count}</Badge>
              ) : null}
            </Button>
          );
        })}
      </div>

      {listQuery.error ? (
        <p className="text-sm text-destructive">Could not load reviews: {(listQuery.error as Error).message}</p>
      ) : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <section className={cn("min-w-0 space-y-2 lg:col-span-4", reviewId && "hidden lg:block")} aria-label="Reviews">
          {listQuery.isPending ? (
            <PageSkeleton variant="list" />
          ) : reviews.length === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title={filter === "pending_review" ? "Nothing waiting on you" : "No reviews here"}
              message="When an agent submits a result, sample or question for review it shows up here."
            />
          ) : (
            reviews.map((review) => <ReviewListItem key={review.id} review={review} selected={review.id === reviewId} />)
          )}
        </section>

        <section className={cn("min-w-0 lg:col-span-8", !reviewId && "hidden lg:block")} aria-label="Review detail">
          {!reviewId ? (
            <EmptyState icon={MessageSquare} message="Select a review to see the result and talk to the agent." />
          ) : detailQuery.isPending ? (
            <PageSkeleton variant="detail" />
          ) : detailQuery.error || !detail ? (
            <p className="text-sm text-destructive">
              Could not load this review{detailQuery.error ? `: ${(detailQuery.error as Error).message}` : "."}
            </p>
          ) : (
            <ReviewDetail review={detail} />
          )}
        </section>
      </div>
    </div>
  );
}

function ReviewListItem({ review, selected }: { review: ReviewItem; selected: boolean }) {
  return (
    <Link
      to={`/reviews/${review.id}`}
      data-testid="review-list-item"
      className={cn(
        "block space-y-2 rounded-lg border p-3 transition-colors hover:bg-accent/50",
        selected ? "border-primary bg-accent/40" : "border-border",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ReviewStatusBadge status={review.status} />
        <Badge variant="outline" className="capitalize">{review.kind}</Badge>
        {review.lavishEnabled ? <Badge variant="outline"><Sparkles />Lavish</Badge> : null}
      </div>
      <p className="line-clamp-2 text-sm font-medium">{review.title}</p>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <AgentAvatar agent={review.agent ?? undefined} name={review.agent?.name} size={16} />
        <span className="truncate">{review.agent?.name ?? "Unknown agent"}</span>
        {review.issue?.identifier ? <span className="shrink-0 font-mono">{review.issue.identifier}</span> : null}
        <span className="ml-auto shrink-0">{relativeTime(review.updatedAt)}</span>
      </div>
      {review.messageCount > 0 ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <MessageSquare className="h-3 w-3" /> {review.messageCount} message{review.messageCount === 1 ? "" : "s"}
        </p>
      ) : null}
    </Link>
  );
}

function ReviewDetail({ review }: { review: ReviewItemDetail }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const agentName = review.agent?.name ?? "the agent";

  const refresh = (next: ReviewItemDetail) => {
    queryClient.setQueryData(queryKeys.reviews.detail(review.companyId, review.id), next);
    void queryClient.invalidateQueries({ queryKey: queryKeys.reviews.all(review.companyId) });
  };

  const setStatus = useMutation({
    mutationFn: (status: ReviewItemStatus) => reviewsApi.update(review.id, { status }),
    onSuccess: (next) => {
      refresh(next);
      pushToast({ title: `Review ${STATUS_PRESENTATION[next.status].label.toLowerCase()}`, tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not update the review", body: error instanceof Error ? error.message : String(error), tone: "error" }),
  });

  const resolved = review.status === "approved" || review.status === "closed";
  const previewSrc = review.contentUrl ? `${review.contentUrl}?v=${encodeURIComponent(review.updatedAt)}` : null;

  return (
    <article className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <Button variant="ghost" size="xs" className="lg:hidden" onClick={() => navigate("/reviews")}>
            <ArrowLeft /> All reviews
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <ReviewStatusBadge status={review.status} />
            <Badge variant="outline" className="capitalize">{review.kind}</Badge>
          </div>
          <h2 className="text-lg font-semibold">{review.title}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <AgentAvatar agent={review.agent ?? undefined} name={review.agent?.name} size={16} />
            <span>{agentName}</span>
            {review.issue?.identifier ? (
              <Link to={`/issues/${review.issue.identifier}`} className="font-mono hover:underline">
                {review.issue.identifier}
              </Link>
            ) : null}
            <span>· submitted {relativeTime(review.createdAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {resolved ? (
            <Button variant="outline" size="sm" onClick={() => setStatus.mutate("pending_review")} disabled={setStatus.isPending}>
              <RotateCcw /> Reopen
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => setStatus.mutate("closed")} disabled={setStatus.isPending}>
                <X /> Close
              </Button>
              <Button variant="outline" size="sm" onClick={() => composerRef.current?.focus()}>
                <MessageSquare /> Request changes
              </Button>
              <Button size="sm" onClick={() => setStatus.mutate("approved")} disabled={setStatus.isPending}>
                <Check /> Approve
              </Button>
            </>
          )}
        </div>
      </div>

      {review.summary ? (
        <div className="rounded-lg border border-border p-3 text-sm">
          <MarkdownBody>{review.summary}</MarkdownBody>
        </div>
      ) : null}

      <LavishStatus review={review} />

      {previewSrc ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="truncate font-mono">{review.filePath ?? "inline HTML"}</span>
            <a href={previewSrc} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 hover:text-foreground">
              Open in new tab <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <iframe
            key={previewSrc}
            title={`${review.title} preview`}
            src={previewSrc}
            // Never add allow-same-origin: the opaque origin isolates agent HTML
            // from Paperclip cookies, storage and the parent DOM.
            sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"
            referrerPolicy="no-referrer"
            className="block h-svh max-h-screen w-full border-0 bg-background"
          />
        </div>
      ) : review.externalUrl ? (
        <a
          href={review.externalUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm hover:bg-accent/50"
        >
          <ExternalLink className="h-4 w-4" /> {review.externalUrl}
        </a>
      ) : null}

      <ReviewThread review={review} />
      {resolved ? null : <ReviewComposer review={review} agentName={agentName} textareaRef={composerRef} onSent={refresh} />}
    </article>
  );
}

function LavishStatus({ review }: { review: ReviewItemDetail }) {
  if (!review.lavishEnabled) return null;
  const ended = review.lavishEndedAt
    ? `Session ended by ${review.lavishEndedBy ?? "unknown"} ${relativeTime(review.lavishEndedAt)}`
    : review.lavishLastPolledAt
      ? `Feedback checked ${relativeTime(review.lavishLastPolledAt)} · every minute`
      : "Waiting for the first feedback check (every minute)";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
      <div className="min-w-0 space-y-1">
        <p className="flex items-center gap-2 font-medium"><Sparkles className="h-4 w-4" /> Interactive Lavish review</p>
        <p className="text-xs text-muted-foreground">
          Annotate elements or text in Lavish and press Send — Paperclip picks it up and wakes {review.agent?.name ?? "the agent"}. {ended}
        </p>
        {review.lavishLastError ? <p className="text-xs text-destructive">Last check failed: {review.lavishLastError}</p> : null}
      </div>
      {review.lavishSessionUrl && !review.lavishEndedAt ? (
        <Button asChild size="sm" variant="outline">
          <a href={review.lavishSessionUrl} target="_blank" rel="noreferrer">
            Open in Lavish <ExternalLink />
          </a>
        </Button>
      ) : null}
    </div>
  );
}

function messageAuthor(message: ReviewMessage, agentName: string): string {
  if (message.authorType === "agent") return agentName;
  if (message.authorType === "system") return "Paperclip";
  return message.source === "lavish" ? "You · via Lavish" : "You";
}

function ReviewThread({ review }: { review: ReviewItemDetail }) {
  if (review.messages.length === 0) {
    return <p className="text-sm text-muted-foreground">No conversation yet. Approve it, or tell {review.agent?.name ?? "the agent"} what to change.</p>;
  }
  const agentName = review.agent?.name ?? "Agent";
  return (
    <ol className="space-y-3" aria-label="Conversation">
      {review.messages.map((message) => (
        <li
          key={message.id}
          data-testid="review-message"
          className={cn(
            "space-y-1 rounded-lg border p-3",
            message.authorType === "user" && "border-primary/40 bg-primary/5",
            message.authorType === "agent" && "border-border",
            message.authorType === "system" && "border-dashed border-border text-muted-foreground",
          )}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {message.authorType === "agent" ? <AgentAvatar agent={review.agent ?? undefined} name={agentName} size={16} /> : null}
            <span className="font-medium text-foreground">{messageAuthor(message, agentName)}</span>
            <span>{relativeTime(message.createdAt)}</span>
            {message.authorType === "agent" && review.lavishEnabled ? (
              <span>{message.lavishDeliveredAt ? "· shown in Lavish" : "· queued for Lavish"}</span>
            ) : null}
          </div>
          <MarkdownBody className="text-sm">{message.body}</MarkdownBody>
        </li>
      ))}
    </ol>
  );
}

function ReviewComposer({
  review,
  agentName,
  textareaRef,
  onSent,
}: {
  review: ReviewItemDetail;
  agentName: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onSent: (next: ReviewItemDetail) => void;
}) {
  const [body, setBody] = useState("");
  const { pushToast } = useToastActions();
  const send = useMutation({
    mutationFn: () => reviewsApi.addMessage(review.id, { body: body.trim() }),
    onSuccess: (next) => {
      setBody("");
      onSent(next);
      pushToast({ title: `Sent to ${agentName}`, body: "The agent was woken up with your feedback.", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not send feedback", body: error instanceof Error ? error.message : String(error), tone: "error" }),
  });

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (body.trim() && !send.isPending) send.mutate();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
  };

  return (
    <form onSubmit={submit} className="space-y-2" aria-label="Reply to agent">
      <Textarea
        ref={textareaRef}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={`Feedback, answers or questions for ${agentName}…`}
        rows={4}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Ctrl/⌘ + Enter to send</span>
        <Button type="submit" size="sm" disabled={!body.trim() || send.isPending}>
          <Send /> Send to {agentName}
        </Button>
      </div>
    </form>
  );
}
