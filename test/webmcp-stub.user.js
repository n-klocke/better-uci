// ==UserScript==
// @name         better-uci WebMCP stub (testing only)
// @namespace    https://github.com/n-klocke/better-uci
// @version      1.0.0
// @description  Fake document.modelContext for testing better-uci's WebMCP tools in a browser without WebMCP. Not for normal use.
// @match        https://buchung.uci-kinowelt.de/*
// @match        https://www.uci-kinowelt.de/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// Registered tools land in window.__webmcp; call one from the console with
//   await __webmcp.call('search_showtimes', { query: 'dune' })
// Does nothing where the browser has a real modelContext.
(function () {
  if (document.modelContext || navigator.modelContext) return;
  const tools = {};
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    value: {
      registerTool(tool) {
        if (tools[tool.name]) return Promise.reject(new DOMException('already registered', 'InvalidStateError'));
        tools[tool.name] = tool;
        return Promise.resolve();
      },
    },
  });
  window.__webmcp = {
    tools,
    list: () => Object.values(tools).map((t) => ({ name: t.name, description: t.description, annotations: t.annotations })),
    call: async (name, input) => {
      const r = await tools[name].execute(input || {}, { signal: new AbortController().signal });
      const text = r && r.content && r.content[0] && r.content[0].text;
      try { return { isError: r.isError, result: JSON.parse(text) }; } catch { return { isError: r.isError, text }; }
    },
  };
})();
