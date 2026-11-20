/**
 * Short titles for a family's threads (docs/design/lead-chat.md, "Family
 * tabs"): the family tabs and the sidebar's rows under a parent show each
 * started thread without the topic it shares with its siblings. Both call
 * this over the same members, so they agree on every label.
 */

/** The first separator in a title, which ends its topic: "Topic: rest", "Topic - rest", "Topic | rest". */
const FIRST_SEPARATOR = /:\s|\s[-–—|/]\s/;
/** That separator, right after a topic. */
const SEPARATOR_AFTER_TOPIC = /^(?::\s+|\s+[-–—|/]\s+)/;
/** A topic longer than this is a sentence, not a name. */
const TOPIC_MAX_CHARS = 40;
/** A shortened title shorter than this says too little; the tab keeps its title. */
const SHORT_TITLE_MIN_CHARS = 2;

/**
 * The siblings' titles without the topic they share, so each tab shows what
 * tells it apart: "Pull Station: Android toolchain setup" and "Pull Station:
 * UI polish pass" become "Android toolchain setup" and "UI polish pass".
 *
 * A topic is the words before the first separator of a title, and it is
 * shared once two or more titles start with it. A topic of two or more words
 * is a name, so a title counts when it goes straight on from it ("Pull Station
 * restructure: start" becomes "Restructure: start"); a one-word topic is often
 * a verb ("Fix"), so only titles with the separator after it count. A title keeps its full text when what is left would be under two
 * characters or would read the same as another tab's.
 */
export function shortFamilyTitles(titles: readonly string[]): readonly string[] {
  // A topic as it was written (`length`, in the title's own characters) and in lower case
  // (`key`, which can be longer: "İ" lowers to two).
  interface Topic {
    readonly key: string;
    readonly length: number;
  }
  // Where the text after `topic` starts in `title`, or null when the topic doesn't lead it.
  const cutAfter = (title: string, topic: Topic): number | null => {
    if (title.slice(0, topic.length).toLowerCase() !== topic.key) return null;
    const after = title.slice(topic.length);
    const separator = SEPARATOR_AFTER_TOPIC.exec(after);
    if (separator !== null) return topic.length + separator[0].length;
    const space = /^\s+(?=\S)/.exec(after);
    return space !== null && /\s/.test(topic.key) ? topic.length + space[0].length : null;
  };
  const shared = new Map<string, Topic>();
  for (const title of titles) {
    const end = title.search(FIRST_SEPARATOR);
    if (end < 1 || end > TOPIC_MAX_CHARS) continue;
    const written = title.slice(0, end).trimEnd();
    const topic = { key: written.toLowerCase(), length: written.length };
    if (topic.key === "" || shared.has(topic.key)) continue;
    if (titles.filter((other) => cutAfter(other, topic) !== null).length >= 2) {
      shared.set(topic.key, topic);
    }
  }
  if (shared.size === 0) return titles;
  const labels = titles.map((title) => {
    let cut: number | null = null;
    let longest = 0;
    for (const topic of shared.values()) {
      if (topic.length <= longest) continue;
      const at = cutAfter(title, topic);
      if (at !== null) [cut, longest] = [at, topic.length];
    }
    if (cut === null) return title;
    const rest = title.slice(cut).trimEnd();
    if (rest.length < SHORT_TITLE_MIN_CHARS) return title;
    // "council round two" reads as a label once capitalised; "iOS build" is left alone.
    return /^[a-z]+\b/.test(rest) ? rest.charAt(0).toUpperCase() + rest.slice(1) : rest;
  });
  // Two that would read the same keep their full titles. A title put back can
  // clash in turn ("Docs: Build" beside "Work: Docs: Build"), so repeat until none do.
  for (let clashed = true; clashed;) {
    clashed = false;
    const counts = new Map<string, number>();
    for (const label of labels) {
      const key = label.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    labels.forEach((label, index) => {
      if (label !== titles[index] && counts.get(label.toLowerCase())! > 1) {
        labels[index] = titles[index]!;
        clashed = true;
      }
    });
  }
  return labels;
}
