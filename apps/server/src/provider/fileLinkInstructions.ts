/**
 * How to cite a file so the chat can open it. Appended to Claude's system
 * prompt and Codex's developer instructions, the same text for both.
 *
 * The chat turns the paths an agent writes into chips that open the file, with
 * a thumbnail for images. A relative path resolves against the working
 * directory and a bare name is searched for inside it, so a file anywhere else
 * can only be reached through its full path. Agents writing for a reader tend
 * to drop that path as noise ("saved `home.png` to your Desktop"), which leaves
 * a chip that opens nothing. Hearing that the chip shows only the name takes
 * away the reason to drop it.
 *
 * Short on purpose, like the browser-panel note: every line here competes with
 * the user's actual task on every turn.
 */
export const FILE_LINK_INSTRUCTIONS = `<threadlines_file_links>
Threadlines turns the file paths in your replies into chips that open the file when clicked, and shows images as thumbnails. A chip displays only the file name, so a full path costs the reader nothing. Inside your working directory, a relative path works. For a file anywhere else, such as a screenshot in a temp folder or an export on the Desktop, write its full absolute path in backticks, like \`C:\\Users\\me\\Desktop\\shots\\home.png\` or \`/Users/me/Desktop/shots/home.png\`. Never refer to such a file by its bare name alone: bare names are searched for only inside your working directory, so the chip would open nothing.
</threadlines_file_links>`;
