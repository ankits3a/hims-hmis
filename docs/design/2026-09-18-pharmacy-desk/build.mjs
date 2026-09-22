// Folds the six pharmacy canvas boards into one self-contained page with a small
// stand-in for the canvas runtime (DCLogic, {{path}} bindings, sc-if, sc-for, onClick).
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = new URL('.', import.meta.url).pathname;
const OUT = '/tmp/pharmacy-desk.html';
const canvas = JSON.parse(readFileSync(`${SRC}/canvas.json`, 'utf8'));

const boards = canvas.order.map((file) => {
  const html = readFileSync(`${SRC}/${file}`, 'utf8');
  const xdc = html.match(/<x-dc>([\s\S]*?)<\/x-dc>/)[1];
  const helmet = (xdc.match(/<helmet>([\s\S]*?)<\/helmet>/) || [, ''])[1];
  const css = [...helmet.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  const markup = xdc.replace(/<helmet>[\s\S]*?<\/helmet>/, '').trim();
  const sm = html.match(/<script type="text\/x-dc" data-dc-script data-props='([^']*)'>([\s\S]*?)<\/script>/);
  const meta = canvas.boards[file];
  return { id: file.replace('.dc.html', ''), title: meta.title, w: meta.w, h: meta.h,
    props: JSON.parse(sm[1]), code: sm[2], css, markup };
});

const deskNote = canvas.notes.n1.text
  .replace('press Play, or use the Tweaks panel to jump between the five stages.',
           'use the stage switch above the board to jump between the five stages.');
const notes = { Desk: deskNote + '\n\nNew: the batch under every drug is a FEFO Batch & Shelf chip. It names the batch that goes out (nearest expiry) and the rack it sits on. Tap it, or press B, to see every batch of that drug by expiry.', _rest: canvas.notes.n2.text };

// Keep "</script" out of the JSON island.
const data = JSON.stringify({ boards, notes }).replace(/<\/(script)/gi, '<\\/$1');
const tpl = readFileSync(new URL('./shell.html', import.meta.url).pathname, 'utf8');
writeFileSync(OUT, tpl.replace('__DATA__', () => data));
console.log('wrote', OUT, (data.length / 1024).toFixed(0) + ' KB of boards,', boards.map((b) => b.id).join(' '));
