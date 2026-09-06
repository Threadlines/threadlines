import { memo } from "react";

export function hasNonZeroStat(stat: { additions: number; deletions: number }): boolean {
  return stat.additions > 0 || stat.deletions > 0;
}

export const DiffStatLabel = memo(function DiffStatLabel(props: {
  additions: number;
  deletions: number;
  showParentheses?: boolean;
  /**
   * What sits between the two counts. The slash reads as one figure and suits
   * a line of meta; a plain space reads as two facts and suits a row that is
   * already ruled into columns.
   */
  separator?: "slash" | "space";
}) {
  const { additions, deletions, showParentheses = false, separator = "slash" } = props;
  return (
    <>
      {showParentheses && <span className="text-muted-foreground/70">(</span>}
      <span className="text-success">+{additions}</span>
      {separator === "slash" ? (
        <span className="mx-0.5 text-muted-foreground/70">/</span>
      ) : (
        <span> </span>
      )}
      <span className="text-destructive">-{deletions}</span>
      {showParentheses && <span className="text-muted-foreground/70">)</span>}
    </>
  );
});
