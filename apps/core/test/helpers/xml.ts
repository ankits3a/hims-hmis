/**
 * PARITY P5 — A STRICT, SMALL XML READER for the Tally export's tests. The claim under test is that
 * the file is well-formed XML Tally can import, so anything off throws: a tag closed out of order, an
 * unknown entity, a bare `&` or `<` in text, a repeated attribute, two roots, text outside the root.
 * No XML library is a dependency of `apps/core`, and a test that trusted the builder's own string to
 * be XML would be checking the builder against itself.
 */
export type XNode = { name: string; attrs: Record<string, string>; children: XNode[]; text: string };

const NAME = /^[A-Za-z_][A-Za-z0-9._:-]*$/;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  if (s.includes("<")) throw new Error(`raw < in text: ${s}`);
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-z]+);|&/g, (_m, e: string | undefined) => {
    if (e === undefined) throw new Error(`bare & in: ${s}`);
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
    const v = NAMED[e];
    if (v === undefined) throw new Error(`unknown entity &${e};`);
    return v;
  });
}

export function parseXml(xml: string): XNode {
  let i = 0;
  if (xml.startsWith("<?xml")) {
    const end = xml.indexOf("?>");
    if (end < 0) throw new Error("unterminated declaration");
    i = end + 2;
  }
  const stack: XNode[] = [];
  let root: XNode | null = null;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const text = xml.slice(i, lt < 0 ? xml.length : lt);
    if (stack.length === 0) {
      if (text.trim() !== "") throw new Error(`text outside the root: ${text.trim().slice(0, 40)}`);
    } else {
      stack[stack.length - 1]!.text += decode(text);
    }
    if (lt < 0) break;
    const gt = xml.indexOf(">", lt);
    if (gt < 0) throw new Error("unterminated tag");
    const tag = xml.slice(lt + 1, gt);
    if (tag.startsWith("/")) {
      const open = stack.pop();
      if (open === undefined || open.name !== tag.slice(1).trim()) throw new Error(`</${tag.slice(1)}> closes ${open?.name ?? "nothing"}`);
    } else {
      const self = tag.endsWith("/");
      const body = self ? tag.slice(0, -1) : tag;
      const m = /^(\S+)((?:\s+[^\s=]+="[^"]*")*)\s*$/.exec(body);
      if (m === null || !NAME.test(m[1]!)) throw new Error(`bad tag <${tag}>`);
      const attrs: Record<string, string> = {};
      for (const a of m[2]!.matchAll(/([^\s=]+)="([^"]*)"/g)) {
        if (!NAME.test(a[1]!) || a[1]! in attrs) throw new Error(`bad or repeated attribute ${a[1]!}`);
        attrs[a[1]!] = decode(a[2]!);
      }
      const node: XNode = { name: m[1]!, attrs, children: [], text: "" };
      if (stack.length === 0) {
        if (root !== null) throw new Error("two roots");
        root = node;
      } else {
        stack[stack.length - 1]!.children.push(node);
      }
      if (!self) stack.push(node);
    }
    i = gt + 1;
  }
  if (stack.length > 0 || root === null) throw new Error(`unclosed <${stack[stack.length - 1]?.name ?? "?"}>`);
  return root;
}

/** Every node of that name, depth first. */
export const allNamed = (n: XNode, name: string): XNode[] => [...(n.name === name ? [n] : []), ...n.children.flatMap((c) => allNamed(c, name))];
/** The text of a direct child. */
export const childText = (n: XNode, name: string): string => n.children.find((c) => c.name === name)?.text ?? "";

/** A Tally AMOUNT (`-123.45`) in paise; anything else throws. */
export function tallyPaise(amount: string): number {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(amount);
  if (m === null) throw new Error(`AMOUNT ${amount} is not ±rupees.paise`);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3]));
}

/** Each VOUCHER in a Tally file with its number and the sum of its AMOUNTs (zero when it balances). */
export function voucherSums(doc: XNode): { number: string; type: string; sum: number; entries: [string, number][] }[] {
  return allNamed(doc, "VOUCHER").map((v) => {
    const entries = allNamed(v, "ALLLEDGERENTRIES.LIST").map((e): [string, number] => [childText(e, "LEDGERNAME"), tallyPaise(childText(e, "AMOUNT"))]);
    return { number: childText(v, "VOUCHERNUMBER"), type: v.attrs.VCHTYPE ?? "", sum: entries.reduce((s, [, a]) => s + a, 0), entries };
  });
}
