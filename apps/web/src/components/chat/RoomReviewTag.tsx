/**
 * The tag on every part of an independent review in a room: the request, the
 * reviewer's working row and its answer. It opens what the reviewer was given,
 * read from the request message, so it stays true after the review ends and
 * after a reload.
 */
import type { TimestampFormat } from "@threadlines/contracts/settings";
import { memo } from "react";

import { describeRoomReviewBasis, ROOM_REVIEW_TAG } from "../../rooms";
import { formatShortTimestamp } from "../../timestampFormat";
import type { ChatMessage } from "../../types";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export const RoomReviewTag = memo(function RoomReviewTag(props: {
  /** The review's request message. */
  request: Pick<ChatMessage, "text" | "reviewInput">;
  timestampFormat: TimestampFormat;
}) {
  const input = props.request.reviewInput;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-room-review-tag="true"
            className="shrink-0 font-mono text-[10.5px] text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
          />
        }
      >
        {ROOM_REVIEW_TAG}
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="w-96 max-w-[calc(100vw-2rem)]"
        viewportClassName="p-3 [--viewport-inline-padding:--spacing(3)]"
      >
        <div className="flex flex-col gap-2.5 text-xs" data-room-review-input="true">
          <p className="font-medium text-foreground">What the reviewer got</p>
          <div>
            <p className="font-mono text-[10.5px] text-muted-foreground">Request</p>
            <p className="max-h-32 overflow-y-auto whitespace-pre-wrap wrap-break-word text-foreground/90">
              {props.request.text}
            </p>
          </div>
          <div>
            <p className="font-mono text-[10.5px] text-muted-foreground">Changes</p>
            <p className="text-foreground/90">
              {input
                ? describeRoomReviewBasis(input.basis, (iso) =>
                    formatShortTimestamp(iso, props.timestampFormat),
                  )
                : "Not recorded."}
            </p>
          </div>
          <p className="text-muted-foreground">No room conversation, no earlier session</p>
          {input && input.diff.length > 0 ? (
            <details className="border-t border-border pt-2">
              <summary className="cursor-pointer select-none text-muted-foreground transition-colors hover:text-foreground">
                Captured diff
              </summary>
              <pre className="mt-1.5 max-h-64 overflow-auto font-mono text-[11px] leading-relaxed text-muted-foreground">
                {input.diff}
              </pre>
            </details>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
