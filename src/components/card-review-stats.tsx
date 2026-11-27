import type { Card } from "@/lib/card-contracts";

const reviewDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function CardReviewStats({ stats }: { stats: Card["reviewStats"] }) {
  const { attempts, correct, nextReviewAt } = stats;
  const due = nextReviewAt ? new Date(nextReviewAt) : null;

  return (
    <dl className="card-review-stats">
      <div>
        <dt>Correct answers</dt>
        <dd>
          {attempts
            ? `${Math.round((correct / attempts) * 100)}% (${correct} of ${attempts})`
            : "No reviews yet"}
        </dd>
      </div>
      <div>
        <dt>Next review</dt>
        <dd>
          {due === null ? (
            "Paused"
          ) : due.getTime() <= Date.now() ? (
            "Due now"
          ) : (
            <time dateTime={nextReviewAt ?? undefined}>
              {reviewDate.format(due)}
            </time>
          )}
        </dd>
      </div>
    </dl>
  );
}
