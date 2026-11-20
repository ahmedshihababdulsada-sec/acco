"""Build a standalone in-memory review copy for the manager or cashier.

Run: python3 scripts/build_manager_preview.py --screen Manager
     python3 scripts/build_manager_preview.py --screen Main
The .dc.html file remains the source used by the existing screen canvas.
"""
from pathlib import Path
import argparse
import json
import re

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--screen', choices=['Manager', 'Main'], default='Manager')
parser.add_argument('--tab', choices=['tasks', 'services', 'stock', 'safe'], default='tasks')
args = parser.parse_args()
source = (ROOT / 'screens' / (args.screen + '.dc.html')).read_text()
markup = re.search(r'<x-dc>(.*?)</x-dc>', source, re.S).group(1)
head = re.search(r'<helmet>(.*?)</helmet>', markup, re.S).group(1)
markup = re.sub(r'<helmet>.*?</helmet>', '', markup, flags=re.S)
markup = re.sub(r'<sc-for\b', '<template data-repeat', markup, flags=re.I)
markup = re.sub(r'</sc-for>', '</template>', markup, flags=re.I)
markup = re.sub(r'<sc-if\b', '<template data-condition', markup, flags=re.I)
markup = re.sub(r'</sc-if>', '</template>', markup, flags=re.I)
logic = re.search(r'<script type="text/x-dc"[^>]*>(.*?)</script>', source, re.S).group(1)
runtime = r'''
const template = document.createElement('template');
template.innerHTML = JSON.parse(document.getElementById('screen-template').textContent);
const host = document.getElementById('screen');
let component;
function value(expression, scope) {
  const path = expression.trim().split('.');
  if (path[0] === 'true') return true;
  if (path[0] === 'false') return false;
  return path.reduce((result, key) => result == null ? undefined : result[key], scope);
}
function binding(raw, scope) {
  const exact = raw.match(/^\{\{([^{}]+)\}\}$/);
  if (exact) return value(exact[1], scope);
  return raw.replace(/\{\{([^{}]+)\}\}/g, (_, key) => String(value(key, scope) ?? ''));
}
function children(parent, scope, key) {
  const fragment = document.createDocumentFragment();
  [...parent.childNodes].forEach((child, index) => fragment.appendChild(build(child, scope, key + ':' + index)));
  return fragment;
}
function build(node, scope, key) {
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(binding(node.textContent, scope) ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return node.cloneNode(false);
  if (node.matches('template[data-repeat]')) {
    const fragment = document.createDocumentFragment();
    const list = binding(node.getAttribute('list'), scope) || [];
    list.forEach((item, index) => fragment.appendChild(children(node.content, Object.assign({}, scope, {[node.getAttribute('as')]: item}), key + ':' + index)));
    return fragment;
  }
  if (node.matches('template[data-condition]')) return binding(node.getAttribute('value'), scope) ? children(node.content, scope, key) : document.createDocumentFragment();
  const output = node.cloneNode(false);
  for (const attr of [...node.attributes]) {
    if (attr.name.startsWith('hint-')) { output.removeAttribute(attr.name); continue; }
    const resolved = binding(attr.value, scope);
    if (/^on(click|change)$/.test(attr.name)) {
      output.removeAttribute(attr.name);
      if (typeof resolved === 'function') {
        const inputEvent = attr.name === 'onchange' && (node.tagName === 'TEXTAREA' || (node.tagName === 'INPUT' && !['checkbox','radio'].includes(node.type)));
        output.addEventListener(inputEvent ? 'input' : attr.name.slice(2), (event) => resolved(event));
      }
    } else if (['checked', 'disabled', 'selected', 'required'].includes(attr.name)) {
      output.removeAttribute(attr.name);
      output[attr.name] = !!resolved;
    } else { output.setAttribute(attr.name, resolved ?? ''); }
  }
  output.appendChild(children(node, scope, key));
  if (node.hasAttribute('value') && ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) output.value = binding(node.getAttribute('value'), scope) ?? '';
  if (['INPUT','TEXTAREA','SELECT','BUTTON'].includes(node.tagName)) output.dataset.previewKey = key;
  return output;
}
function render() {
  const focused = document.activeElement;
  const key = focused?.dataset.previewKey;
  let start = null, end = null;
  try { start = focused.selectionStart; end = focused.selectionEnd; } catch {}
  host.replaceChildren(children(template.content, component.renderVals(), 'screen'));
  if (key) {
    const replacement = [...host.querySelectorAll('[data-preview-key]')].find((node) => node.dataset.previewKey === key);
    if (replacement) { replacement.focus({preventScroll:true}); if (start != null) { try { replacement.setSelectionRange(start,end); } catch {} } }
  }
}
class DCLogic { setState(next) { this.state = Object.assign({}, this.state, next); render(); } }
'''
payload = json.dumps(markup, ensure_ascii=False).replace('<', '\\u003c')
initial_state = 'component.state.tab = ' + json.dumps(args.tab) + ';' if args.screen == 'Manager' else 'component.state.showShift = true;'
title = 'معاينة المدير — مركز التجميل' if args.screen == 'Manager' else 'معاينة الكاشير — مركز التجميل'
page = '<!doctype html>\n<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + title + '</title>' + head + '</head><body><nav aria-label="معاينات الأدوار" style="padding:8px 20px;background:#E3F1F0;font:13px system-ui;display:flex;gap:20px"><a href="Manager.html">معاينة المدير</a><a href="Main.html">معاينة الكاشير</a></nav><main id="screen"></main><script type="application/json" id="screen-template">' + payload + '</script><script>\n' + runtime + '\n' + logic + "\ncomponent = new Component(); " + initial_state + " render();\n</script></body></html>\n"
output = ROOT / 'previews' / (args.screen + '.html')
output.parent.mkdir(exist_ok=True)
output.write_text(page)
print(output)
