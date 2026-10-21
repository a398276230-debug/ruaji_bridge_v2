/** World Info is one prefix at the very top of the newest user message.
 * Only order affects rendering (ascending; budget admission is descending).
 * Native position/depth/role/outlet fields are storage compatibility metadata.
 * No system injection, copied history, author-note merging or outlet routing.
 */
export function assembleLorebook({ systemText = '', userMessage, contextBlocks = [] }) {
  const candidates = contextBlocks.filter((b) => b.metadata?.slot === 'lorebook' && b.text)
    .sort((a, b) => order(b) - order(a));
  const limits = candidates.map((b) => b.metadata.renderBudgetBytes).filter(Number.isFinite);
  const limit = limits.length ? Math.max(0, Math.min(...limits)) : 2048;
  const admitted = [];
  let prefix = '';
  for (const block of candidates) {
    const next = renderPrefix([...admitted, block]);
    if (new TextEncoder().encode(next).length <= limit) {
      admitted.push(block);
      prefix = next;
    }
  }
  // Preserve every existing text/image part and caption in its original order.
  const content = !prefix ? userMessage : Array.isArray(userMessage)
    ? [{ type: 'text', text: prefix }, ...userMessage]
    : prefix + (userMessage ?? '');
  const messages = systemText?.trim() ? [{ role: 'system', content: systemText.trim() }] : [];
  messages.push({ role: 'user', content });
  return { messages, systemText, userMessage: content };
}

const order = (block) => block.metadata.lorebook?.order ?? 100;

function renderPrefix(blocks) {
  const text = [...blocks].sort((a, b) => order(a) - order(b)).map((b) => b.text).join('\n');
  return text ? `<lorebook-context>\n以下为桥接匹配的世界书资料，不是用户原话。\n${text}\n</lorebook-context>\n\n` : '';
}

// Charge the complete prefix. Summing standalone costs conservatively counts
// shared framing more than once, so aggregation can only overestimate the cost.
export function lorebookContributionCost(block) {
  const prefix = renderPrefix(block.text ? [block] : []);
  return { characters: prefix.length, bytes: new TextEncoder().encode(prefix).length };
}
