/* ==========================================================================
   CarbonBridge prototype — client

   Architecture
   ------------
   localStorage is the single source of truth for everything the farmer has
   done: their answers, their field, their batches, and how far through the
   season they are.

   The Flask server is stateless. It is asked to calculate things (income
   estimate, season totals) and to judge things (OTP, eligibility, evidence
   quality). It never remembers who is asking. The one exception is uploaded
   photo files, which must live server-side so their bytes can be hashed for
   duplicate detection.

   Screens are sections in one document, shown and hidden by a hash router.
   ========================================================================== */

(function () {
  "use strict";

  var STORE_KEY = "carbonbridge.v1";
  var DEMO = window.SB_DEMO || {};
  var TRAINING = window.SB_TRAINING || [];
  var CONST = window.SB_CONST || {};

  /* ----------------------------------------------------------------------
     The eight dashboard stages.
     Every screen maps onto one of these. The farmer sees these, not the
     eighteen screens underneath.
     ---------------------------------------------------------------------- */
  var STAGES = [
    { key: "farm",         label: "Field registered" },
    { key: "eligibility",  label: "Eligibility" },
    { key: "training",     label: "Training done" },
    { key: "producing",    label: "Making biochar" },
    { key: "evidence",     label: "Evidence review" },
    { key: "verification", label: "Verification" },
    { key: "issued",       label: "Credits issued" },
    { key: "paid",         label: "Payment" }
  ];

  var VERIFY_STEPS = [
    { key: "collected", label: "Evidence collected",
      note: "Your batches passed our quality check." },
    { key: "prepared",  label: "Verification package prepared",
      note: "Photos, weights, locations and field records assembled." },
    { key: "submitted", label: "Submitted to independent verifier",
      note: "Sent to " + (DEMO.verifier || "the verifier") + "." },
    { key: "review",    label: "Under review",
      note: "Usually takes four to six weeks." },
    { key: "moreinfo",  label: "Additional information requested",
      note: "The verifier has asked for one more photo." },
    { key: "complete",  label: "Verification completed",
      note: "The verifier has finished its assessment." }
  ];

  var SALE_STEPS = [
    { key: "issued",   label: "Credits issued", note: "Recorded in the registry." },
    { key: "listed",   label: "Listed for corporate buyers", note: "Offered to companies buying carbon removal." },
    { key: "matched",  label: "Buyer secured", note: "" },
    { key: "sold",     label: "Sale completed", note: "" },
    { key: "paying",   label: "Payment processing", note: "" }
  ];

  var CREDIT_CHAIN = ["Issued", "Listed", "Buyer matched", "Sold", "Retired"];

  var ELIGIBILITY_QUESTIONS = [
    {
      id: "prior_biochar",
      text: "Have you made biochar from straw on this field before?",
      why: "If you already did it without being paid, it may not count as a new activity.",
      options: [{ v: "no", l: "No" }, { v: "yes", l: "Yes" }]
    },
    {
      id: "legally_required",
      text: "Does the law already require you to turn your straw into biochar?",
      why: "A local burning ban is normal. What matters is whether biochar itself is required.",
      options: [{ v: "no", l: "No" }, { v: "yes", l: "Yes" }, { v: "unsure", l: "Not sure" }]
    },
    {
      id: "other_project",
      text: "Is this field already in another carbon project?",
      why: "The same field cannot be counted twice.",
      options: [{ v: "no", l: "No" }, { v: "yes", l: "Yes" }]
    },
    {
      id: "straw_practice",
      text: "What did you do with your straw last season?",
      why: "This sets the baseline your results are measured against.",
      options: [
        { v: "burned", l: "Burned it" },
        { v: "incorporated", l: "Ploughed it in" },
        { v: "sold", l: "Sold or removed it" }
      ]
    },
    {
      id: "ownership",
      text: "Do you own this land or rent it?",
      why: "Whoever owns the land has a say in the carbon income.",
      options: [{ v: "owner", l: "I own it" }, { v: "tenant", l: "I rent it" }]
    },
    {
      id: "has_rights",
      text: "Do you have permission to enter this field into the project?",
      why: "Tenants need the landowner's written consent.",
      options: [{ v: "yes", l: "Yes" }, { v: "no", l: "Not yet" }]
    },
    {
      id: "kiln_access",
      text: "Do you have a way to make biochar?",
      why: "If not, CarbonBridge provides one. This does not stop you joining.",
      options: [
        { v: "own", l: "I have a kiln" },
        { v: "shared", l: "I can share one" },
        { v: "none", l: "I have none" }
      ]
    }
  ];

  /* ======================================================================
     STATE
     ====================================================================== */

  var defaultState = {
    stage: 0,
    onboarded: false,
    name: "",
    mobile: "",
    consented: false,
    estimate: null,
    estimateInput: null,
    farm: null,
    eligibility: null,
    trainingDone: false,
    trainingIndex: 0,
    batches: [],
    draft: null,
    verifyStep: 0,
    saleStep: 0,
    moreInfoDone: false,
    season: null,
    advance: null,
    seasonNumber: 1,
    updates: []
  };

  var state = load();

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return clone(defaultState);
      var parsed = JSON.parse(raw);
      var merged = clone(defaultState);
      Object.keys(parsed).forEach(function (k) {
        if (k in merged) merged[k] = parsed[k];
      });
      return merged;
    } catch (e) {
      return clone(defaultState);
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      /* Storage may be full or disabled. The app still works for this
         session; the farmer just loses progress on refresh. */
    }
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function addUpdate(text) {
    state.updates.unshift({ text: text, at: nowLabel() });
    state.updates = state.updates.slice(0, 6);
  }

  function setStage(n) {
    if (n > state.stage) state.stage = n;
  }

  /* ======================================================================
     SMALL HELPERS
     ====================================================================== */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  var vnd = new Intl.NumberFormat("vi-VN");

  function dong(n) {
    if (n === null || n === undefined || isNaN(n)) return "0\u00A0\u20AB";
    return vnd.format(Math.round(n / 1000) * 1000) + "\u00A0\u20AB";
  }

  function nowLabel() {
    return new Date().toLocaleDateString("en-US", {
      day: "numeric", month: "short"
    });
  }

  function showError(node, message) {
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
  }

  function clearError(node) {
    if (!node) return;
    node.textContent = "";
    node.hidden = true;
  }

  var toastTimer = null;
  function toast(message) {
    var node = $("#toast");
    node.textContent = message;
    node.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.classList.remove("is-on");
    }, 2600);
  }

  function busy(button, on, labelWhenBusy) {
    if (!button) return;
    if (on) {
      button.dataset.label = button.textContent;
      button.textContent = labelWhenBusy || "Working\u2026";
      button.disabled = true;
    } else {
      if (button.dataset.label) button.textContent = button.dataset.label;
      button.disabled = false;
    }
  }

  /* ======================================================================
     API
     ====================================================================== */

  function api(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    })
      .then(function (res) {
        return res.json().catch(function () {
          throw new Error("The server sent something we could not read.");
        }).then(function (data) {
          if (!res.ok || data.ok === false) {
            throw new Error(data.error || "Something went wrong. Please try again.");
          }
          return data;
        });
      })
      .catch(function (err) {
        if (err instanceof TypeError) {
          throw new Error("Could not reach the server. Check your connection.");
        }
        throw err;
      });
  }

  function apiUpload(file, slot) {
    var form = new FormData();
    form.append("photo", file);
    form.append("slot", slot);
    return fetch("/api/upload-evidence", { method: "POST", body: form })
      .then(function (res) {
        return res.json().catch(function () {
          throw new Error("Upload failed. Please try again.");
        }).then(function (data) {
          if (!res.ok || data.ok === false) {
            throw new Error(data.error || "Upload failed. Please try again.");
          }
          return data;
        });
      })
      .catch(function (err) {
        if (err instanceof TypeError) {
          throw new Error("Could not reach the server. Check your connection.");
        }
        throw err;
      });
  }

  /* ======================================================================
     ROUTER

     Hash-based so no server-side catch-all route is needed. A guard keeps
     the farmer out of screens they have not reached yet — otherwise a
     bookmarked #/issued would show credits for a field that does not exist.
     ====================================================================== */

  var ROUTES = {
    "landing": { title: "CarbonBridge", open: true },
    "estimator": { title: "Estimate", open: true },
    "estimate-result": { title: "Your estimate", open: true, needs: function () { return state.estimate; } },
    "signup": { title: "Sign up", open: true },
    "consent": { title: "Your data", needs: function () { return state.onboarded; } },
    "farm": { title: "Register field", needs: function () { return state.consented; } },
    "eligibility": { title: "Checks", needs: function () { return state.farm; } },
    "eligibility-result": { title: "Checks", needs: function () { return state.eligibility; } },
    "dashboard": { title: "Home", needs: function () { return state.farm; } },
    "training": { title: "Training", needs: function () { return state.farm; } },
    "evidence": { title: "New batch", needs: function () { return state.trainingDone; } },
    "quality": { title: "Quality check", needs: function () { return state.draft && state.draft.result; } },
    "verification": { title: "Verification", needs: function () { return state.stage >= 5; } },
    "more-evidence": { title: "More evidence", needs: function () { return state.stage >= 5; } },
    "issued": { title: "Credits issued", needs: function () { return state.stage >= 6 && state.season; } },
    "sale": { title: "Sale", needs: function () { return state.stage >= 6 && state.season; } },
    "payment": { title: "Payment", needs: function () { return state.stage >= 7 && state.season; } },
    "terms": { title: "Fees and terms", open: true }
  };

  var currentScreen = null;

  function fallbackScreen() {
    if (!state.farm) return state.estimate ? "estimate-result" : "landing";
    return "dashboard";
  }

  function go(name, replace) {
    var target = "#/" + name;
    if (replace) location.replace(target);
    else location.hash = target;
  }

  function route() {
    var name = (location.hash || "").replace(/^#\/?/, "") || "landing";
    var def = ROUTES[name];

    if (!def) {
      go(fallbackScreen(), true);
      return;
    }
    if (def.needs && !def.needs()) {
      var fb = fallbackScreen();
      toast("Finish the earlier steps first.");
      go(fb, true);
      return;
    }

    show(name);
  }

  function show(name) {
    $$(".screen").forEach(function (s) {
      s.hidden = s.dataset.screen !== name;
    });
    currentScreen = name;

    var def = ROUTES[name] || {};
    var bar = $("#appbar");
    bar.hidden = (name === "landing");
    $("#appbar-title").textContent = def.title || "CarbonBridge";
    $("#btn-home").hidden = !state.farm;
    renderOnboardingProgress(name);

    if (RENDER[name]) RENDER[name]();

    window.scrollTo(0, 0);
    var heading = $('.screen[data-screen="' + name + '"] h1');
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
  }

  function renderOnboardingProgress(name) {
    var flow = ["estimator", "estimate-result", "signup", "consent", "farm", "eligibility"];
    var index = flow.indexOf(name);
    var progress = $("#cb-prog");
    progress.hidden = index === -1;
    if (index !== -1) $("i", progress).style.width = ((index + 1) / flow.length * 100) + "%";
  }

  /* ======================================================================
     STAGE MODEL — what the farmer should do next
     ====================================================================== */

  function nextAction() {
    if (!state.farm) {
      return { title: "Register your field", body: "We need to know where your field is before anything else.", time: "About 3 minutes", cta: "Register field", go: "farm" };
    }
    if (!state.eligibility) {
      return { title: "Answer a few checks", body: "Seven quick questions about your field and your straw.", time: "About 2 minutes", cta: "Start checks", go: "eligibility" };
    }
    if (state.eligibility.status === "blocked") {
      return { title: "Your field cannot join yet", body: "Something in your answers stops this field from being submitted.", time: "", cta: "See what to fix", go: "eligibility-result" };
    }
    if (!state.trainingDone) {
      return { title: "Learn how to make biochar", body: "Eight short cards. Read them before your first batch.", time: "About 5 minutes", cta: "Start training", go: "training" };
    }
    if (state.stage < 5) {
      if (state.batches.length === 0) {
        return { title: "Record your first batch", body: "After you run the kiln, take three photos and note the weights.", time: "About 4 minutes", cta: "Record a batch", go: "evidence" };
      }
      return {
        title: "Record another batch, or submit",
        body: "You have " + state.batches.length + " batch" + (state.batches.length === 1 ? "" : "es") + " ready. Add more, or send them for verification.",
        time: "About 4 minutes",
        cta: "Record a batch",
        go: "evidence",
        alt: { cta: "Submit for verification", act: "submit" }
      };
    }
    if (state.stage === 5) {
      var step = VERIFY_STEPS[state.verifyStep];
      if (step && step.key === "moreinfo" && !state.moreInfoDone) {
        return { title: "The verifier needs one photo", body: "They want to see the biochar spread on your field. Please reply within seven days.", time: "About 2 minutes", cta: "Upload the photo", go: "more-evidence" };
      }
      return { title: "Verification in progress", body: "Nothing needed from you right now. We will tell you if that changes.", time: "", cta: "See progress", go: "verification" };
    }
    if (state.stage === 6) {
      return { title: "Your credits are issued", body: "See how many were issued and what happens to them next.", time: "", cta: "See my credits", go: "issued" };
    }
    return { title: "You have been paid", body: "This season is complete. See the details, or join the next season.", time: "", cta: "See payment", go: "payment" };
  }

  function stageNote() {
    switch (state.stage) {
      case 0: return "Just getting started.";
      case 1: return "Your field is registered.";
      case 2: return "Checks complete.";
      case 3: return "Ready to make biochar.";
      case 4: return "Recording batches this season.";
      case 5: return "With the independent verifier.";
      case 6: return "Credits issued to the registry.";
      default: return "Season complete.";
    }
  }

  /* ======================================================================
     RENDERERS
     ====================================================================== */

  var RENDER = {};

  /* --- estimator -------------------------------------------------------- */

  var PRACTICES = [
    { v: "burned", l: "I burn it in the field" },
    { v: "incorporated", l: "I plough it back in" },
    { v: "sold", l: "I sell it or take it away" },
    { v: "unsure", l: "I am not sure" }
  ];

  var estPractice = null;
  var estSeasons = 2;
  var estUnit = "ha";
  var farmUnit = "ha";

  function setEstimatorUnit(unit) {
    estUnit = unit;
    $("#est-unit-label").textContent = unit === "cong" ? "công" : "ha";
    $("#est-unit-note").hidden = unit !== "cong";
    $$("#form-estimate [data-unit]").forEach(function (button) {
      button.setAttribute("aria-pressed", button.dataset.unit === unit ? "true" : "false");
    });
  }

  RENDER.estimator = function () {
    var box = $("#est-practice");
    if (box.childElementCount === 0) {
      PRACTICES.forEach(function (p) {
        var b = el("button", "choice");
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", "false");
        b.dataset.value = p.v;
        b.appendChild(el("span", "choice-dot"));
        b.appendChild(el("span", null, p.l));
        b.addEventListener("click", function () {
          estPractice = p.v;
          $$(".choice", box).forEach(function (c) {
            var on = c === b;
            c.classList.toggle("is-on", on);
            c.setAttribute("aria-checked", on ? "true" : "false");
          });
          clearError($("#est-practice-err"));
        });
        box.appendChild(b);
      });
    }
    if (state.estimateInput) {
      $("#est-size").value = state.estimateInput.farm_size;
      estPractice = state.estimateInput.straw_practice;
      estSeasons = state.estimateInput.seasons;
      setEstimatorUnit(state.estimateInput.unit || "ha");
      $$(".choice", box).forEach(function (c) {
        var on = c.dataset.value === estPractice;
        c.classList.toggle("is-on", on);
        c.setAttribute("aria-checked", on ? "true" : "false");
      });
      $$("#est-seasons .seg").forEach(function (s) {
        var on = Number(s.dataset.value) === estSeasons;
        s.classList.toggle("is-on", on);
        s.setAttribute("aria-checked", on ? "true" : "false");
      });
    }
  };

  RENDER.farm = function () {
    farmUnit = (state.estimate && state.estimate.unit) || farmUnit || "ha";
    $("#fm-unit-label").textContent = farmUnit === "cong" ? "công" : "ha";
  };

  RENDER["estimate-result"] = function () {
    var e = state.estimate;
    if (!e) return;

    $("#er-stage").textContent = e.stage;
    $("#er-stage-note").textContent = e.stage_note;
    $("#er-income").textContent = vnd.format(e.income_low) + "\u2013" + dong(e.income_high);
    $("#er-disclaimer").textContent = e.disclaimer;
    $("#er-tonnes").textContent = e.tonnes_low + "\u2013" + e.tonnes_high + " t";
    $("#er-confidence").textContent = e.confidence;
    renderAllocation($("#er-split"));
    $("#er-practice-note").textContent = e.practice_note;
    renderEstimateChain(e);

    var minBox = $("#er-minimum-box");
    if (e.meets_minimum) {
      minBox.hidden = true;
    } else {
      minBox.hidden = false;
      $("#er-minimum-note").textContent = e.minimum_note;
    }

    var list = $("#er-assumptions");
    list.innerHTML = "";
    e.assumptions.forEach(function (a) { list.appendChild(el("li", null, a)); });

    var feats = $("#er-features");
    feats.innerHTML = "";
    (e.model_features.looked_up_automatically || []).forEach(function (f) {
      feats.appendChild(el("li", null, f));
    });
  };

  function renderEstimateChain(estimate) {
    var chain = $("#er-chain");
    chain.innerHTML = "";
    var items = [
      { value: estimate.straw_collected_t + " t", label: "Straw collected" },
      { value: estimate.biochar_mass_t + " t", label: "Biochar made" },
      { value: estimate.tonnes_low + "–" + estimate.tonnes_high + " t", label: "CO₂ locked in" }
    ];
    items.forEach(function (item, index) {
      var card = el("div");
      card.appendChild(el("b", null, item.value));
      card.appendChild(el("span", null, item.label));
      chain.appendChild(card);
      if (index < items.length - 1) chain.appendChild(el("em", null, "→"));
    });
  }

  /* --- eligibility ------------------------------------------------------ */

  var eligAnswers = {};

  RENDER.eligibility = function () {
    var box = $("#elig-questions");
    if (box.childElementCount > 0) return;

    ELIGIBILITY_QUESTIONS.forEach(function (q) {
      var wrap = el("fieldset", "field");
      var legend = el("legend", "label", q.text);
      wrap.appendChild(legend);

      var why = el("p", "hint", q.why);
      why.style.marginTop = "-4px";
      why.style.marginBottom = "10px";
      wrap.appendChild(why);

      var choices = el("div", "choices");
      choices.setAttribute("role", "radiogroup");
      q.options.forEach(function (opt) {
        var b = el("button", "choice");
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", "false");
        b.appendChild(el("span", "choice-dot"));
        b.appendChild(el("span", null, opt.l));
        b.addEventListener("click", function () {
          eligAnswers[q.id] = opt.v;
          $$(".choice", choices).forEach(function (c) {
            var on = c === b;
            c.classList.toggle("is-on", on);
            c.setAttribute("aria-checked", on ? "true" : "false");
          });
        });
        choices.appendChild(b);
      });
      wrap.appendChild(choices);

      var err = el("p", "err");
      err.hidden = true;
      err.dataset.for = q.id;
      err.setAttribute("role", "alert");
      wrap.appendChild(err);

      box.appendChild(wrap);
    });
  };

  RENDER["eligibility-result"] = function () {
    var r = state.eligibility;
    if (!r) return;

    var icon = $("#elig-icon");
    icon.className = "result-icon";
    if (r.status === "passed") {
      icon.classList.add("icon-good");
      icon.textContent = "\u2713";
    } else if (r.status === "more_info") {
      icon.classList.add("icon-warn");
      icon.textContent = "!";
    } else {
      icon.classList.add("icon-bad");
      icon.textContent = "\u2715";
    }

    $("#elig-title").textContent = r.headline;
    $("#elig-disclaimer").textContent = r.disclaimer;

    renderNoteBlock($("#elig-blocking"), r.blocking, "What stops this field", "callout-bad", "issue-list");
    renderNoteBlock($("#elig-flags"), r.flags, "What the verifier will ask about", "callout-warn", "warn-list");
    renderNoteBlock($("#elig-notes"), r.notes, "Worth knowing", "", "tick-list");

    var btn = $("#btn-elig-continue");
    btn.textContent = r.status === "blocked" ? "Back to home" : "Continue to training";
    btn.disabled = false;
  };

  function renderNoteBlock(container, items, heading, calloutClass, listClass) {
    container.innerHTML = "";
    if (!items || items.length === 0) return;
    var box = el("div", "callout " + calloutClass);
    box.appendChild(el("strong", null, heading));
    var ul = el("ul", "tick-list " + listClass);
    items.forEach(function (t) { ul.appendChild(el("li", null, t)); });
    box.appendChild(ul);
    container.appendChild(box);
  }

  /* --- dashboard -------------------------------------------------------- */

  RENDER.dashboard = function () {
    $("#dash-greeting").textContent =
      state.name ? "Hello, " + state.name.split(" ")[0] : "Hello";

    var prog = $("#dash-progress");
    prog.innerHTML = "";
    var track = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    track.setAttribute("class", "journey-track");
    track.setAttribute("viewBox", "0 0 400 164");
    track.setAttribute("preserveAspectRatio", "none");
    track.setAttribute("aria-hidden", "true");
    var points = [[50, 43], [150, 43], [250, 43], [350, 43], [350, 121], [250, 121], [150, 121], [50, 121]];
    for (var p = 0; p < points.length - 1; p += 1) {
      var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", points[p][0]);
      line.setAttribute("y1", points[p][1]);
      line.setAttribute("x2", points[p + 1][0]);
      line.setAttribute("y2", points[p + 1][1]);
      line.setAttribute("class", p < state.stage ? "is-done" : "");
      track.appendChild(line);
    }
    prog.appendChild(track);
    STAGES.forEach(function (s, i) {
      var li = el("li", "journey-node");
      if (i < state.stage) li.classList.add("is-done");
      if (i === state.stage) li.classList.add("is-now");
      if (i >= 4) li.classList.add("journey-lower");
      var marker = el("span", "journey-marker");
      marker.setAttribute("aria-hidden", "true");
      marker.innerHTML = stageSymbol(s.key, i < state.stage);
      li.appendChild(marker);
      li.appendChild(el("span", "p-label", s.label));
      if (i < state.stage) li.setAttribute("aria-label", s.label + ", done");
      if (i === state.stage) li.setAttribute("aria-current", "step");
      prog.appendChild(li);
    });
    $("#dash-progress-count").textContent = "Step " + (state.stage + 1) + " of " + STAGES.length;
    $("#dash-progress-step").textContent =
      "Step " + (state.stage + 1) + " of " + STAGES.length + ": " + STAGES[state.stage].label;
    $("#dash-progress-note").textContent = stageNote();

    var next = nextAction();
    $("#next-title").textContent = next.title;
    $("#next-body").textContent = next.body;
    $("#next-time").textContent = next.time;
    $("#next-time").hidden = !next.time;

    var btn = $("#btn-next-action");
    btn.textContent = next.cta;
    btn.onclick = function () {
      if (next.go) go(next.go);
    };

    var oldAlt = $("#btn-next-alt");
    if (oldAlt) oldAlt.remove();
    if (next.alt) {
      var alt = el("button", "linkbtn", next.alt.cta);
      alt.id = "btn-next-alt";
      alt.type = "button";
      alt.addEventListener("click", submitForVerification);
      $("#dash-next").appendChild(alt);
    }

    renderIncomeCard();
    renderFarmCard();
    renderBatchCard();

    var ups = $("#dash-updates");
    ups.innerHTML = "";
    if (state.updates.length === 0) {
      ups.appendChild(el("li", null, "Nothing yet. Updates appear here as your project moves along."));
    } else {
      state.updates.forEach(function (u) {
        var li = el("li", null, u.text);
        li.appendChild(el("span", "u-date", u.at));
        ups.appendChild(li);
      });
    }
  };

  /* Inline SVG keeps the journey clear on inexpensive phones without a font
     download or platform-dependent emoji artwork. */
  function stageSymbol(key, done) {
    if (done) return '<svg viewBox="0 0 24 24" focusable="false"><path d="M5 12.5l4.2 4.1L19.5 6.8"/></svg>';
    var symbols = {
      farm: '<svg viewBox="0 0 24 24" focusable="false"><path d="M4 19h16M6 16c1.7-4.5 4-6.8 6-6.8S16.3 11.5 18 16M12 9V5m0 0c2.7 0 4.5 1.4 5.5 3.2C14.7 8.4 13 7.2 12 5Z"/></svg>',
      eligibility: '<svg viewBox="0 0 24 24" focusable="false"><rect x="6" y="4" width="12" height="16" rx="2"/><path d="M9 9h6M9 13h6M9 17h3"/></svg>',
      training: '<svg viewBox="0 0 24 24" focusable="false"><path d="M4 6.5c3-1.4 5.7-1 8 1.1 2.3-2.1 5-2.5 8-1.1v11c-3-1.4-5.7-1-8 1.1-2.3-2.1-5-2.5-8-1.1v-11Z"/><path d="M12 7.6v11"/></svg>',
      producing: '<svg viewBox="0 0 24 24" focusable="false"><path d="M12.1 3.5c1.3 3.2-1 4.7-1 6.7 0 1.2.8 2.1 1.8 2.1 1.5 0 2.3-1.5 1.8-3.2 3.2 2.2 4.3 4.6 4.3 7 0 3.1-2.6 5.4-6.9 5.4s-7-2.3-7-5.8c0-3.5 2.5-6.4 7-12.2Z"/></svg>',
      evidence: '<svg viewBox="0 0 24 24" focusable="false"><rect x="4" y="7" width="16" height="12" rx="2"/><path d="M8 7l1.2-2h5.6L16 7m-8 8 2.7-2.7 2.2 2.2 1.5-1.5L17 15.7"/></svg>',
      verification: '<svg viewBox="0 0 24 24" focusable="false"><circle cx="10" cy="10" r="5"/><path d="m14 14 5 5M8 10l1.4 1.4 2.7-3"/></svg>',
      issued: '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 3.5 14.2 6l3.3-.2.7 3.2 2.6 2-1.7 2.8.5 3.2-3.1 1.2-1.4 2.9-3-1.2-3 1.2-1.4-2.9-3.1-1.2.5-3.2L3.3 11l2.6-2 .7-3.2 3.3.2L12 3.5Z"/><path d="m8.5 12.2 2.2 2.1 4.8-4.8"/></svg>',
      paid: '<svg viewBox="0 0 24 24" focusable="false"><path d="M4 7h16v11H4zM4 10h16M7 15h3"/></svg>'
    };
    return symbols[key] || symbols.farm;
  }

  function renderIncomeCard() {
    var money = $("#dash-income");
    var note = $("#dash-income-note");
    var advBtn = $("#btn-advance-open");

    if (state.stage >= 7 && state.season) {
      money.textContent = dong(state.season.paid_out);
      note.textContent = "Paid on " + DEMO.payment_date + ".";
      advBtn.hidden = true;
      return;
    }
    if (state.season) {
      money.textContent = dong(state.season.farmer_payment - advanceTaken());
      note.textContent = "From " + state.season.credits_now +
        " credits sold. A further " + state.season.credits_held +
        " are held as a safeguard.";
      advBtn.hidden = state.stage >= 7;
      return;
    }
    if (state.estimate) {
      money.textContent = vnd.format(state.estimate.income_low) + "\u2013" +
        dong(state.estimate.income_high);
      note.textContent = "An estimate, not a guaranteed payment. The final " +
        "figure depends on independent verification and the sale price.";
      advBtn.hidden = state.batches.length === 0;
      return;
    }
    money.textContent = "\u2014";
    note.textContent = "Register your field to see an estimate.";
    advBtn.hidden = true;
  }

  function renderFarmCard() {
    var dl = $("#dash-farm");
    dl.innerHTML = "";
    if (!state.farm) return;
    var f = state.farm;
    kv(dl, "Name", f.field_name);
    kv(dl, "Size", (f.size_entered !== undefined ? f.size_entered : f.farm_size) +
      " " + (f.unit === "cong" ? "công" : "ha"));
    kv(dl, "Crop", "Rice");
    kv(dl, "Location", f.lat.toFixed(4) + ", " + f.lng.toFixed(4));
    kv(dl, "Land", f.ownership === "tenant" ? "Rented" : "Owned");
    kv(dl, "Field ID", f.farm_id, true);
    if (f.boundary && f.boundary.length >= 3) {
      kv(dl, "Boundary", f.boundary.length + " points marked");
    }
  }

  function renderBatchCard() {
    var card = $("#dash-batches-card");
    var list = $("#dash-batches");
    list.innerHTML = "";
    if (state.batches.length === 0) { card.hidden = true; return; }
    card.hidden = false;
    state.batches.forEach(function (b, i) {
      var li = el("li");
      var left = el("div");
      left.appendChild(el("span", "b-name", "Batch " + (i + 1)));
      left.appendChild(el("span", "b-meta", b.date + " \u00b7 " + b.biochar_kg + " kg biochar"));
      li.appendChild(left);
      li.appendChild(el("span", "b-meta", b.yield_pct ? b.yield_pct + "% yield" : ""));
      list.appendChild(li);
    });
  }

  function kv(dl, key, value, mono) {
    var row = el("div");
    row.appendChild(el("dt", null, key));
    var dd = el("dd", mono ? "mono" : null, value);
    row.appendChild(dd);
    dl.appendChild(row);
  }

  /* --- training --------------------------------------------------------- */

  RENDER.training = function () {
    drawTraining();
  };

  function drawTraining() {
    var i = Math.max(0, Math.min(state.trainingIndex, TRAINING.length - 1));
    var card = TRAINING[i];
    if (!card) return;

    var prog = $("#train-progress");
    prog.innerHTML = "";
    TRAINING.forEach(function (_, n) {
      var d = el("span", "tp-dot");
      if (n < i) d.classList.add("is-done");
      if (n === i) d.classList.add("is-now");
      prog.appendChild(d);
    });
    prog.setAttribute("aria-label", "Card " + (i + 1) + " of " + TRAINING.length);

    var box = $("#train-card");
    box.innerHTML = "";
    var c = el("div", "train-card");
    var glyph = el("div", "tc-illustration");
    glyph.appendChild(trainingIllustration(card.icon));
    c.appendChild(glyph);
    c.appendChild(el("h2", "tc-title", card.title));
    c.appendChild(el("p", "tc-body", card.body));
    c.appendChild(el("p", "tc-count", "Card " + (i + 1) + " of " + TRAINING.length));
    box.appendChild(c);

    $("#btn-train-prev").disabled = (i === 0);
    $("#btn-train-next").textContent =
      (i === TRAINING.length - 1) ? "Finish training" : "Next";
  }

  /* One small flat-shape scene per training card, drawn from primitives
     (no icon font, no external images — nothing with an unclear licence).
     A tiny 38px stroke icon used to sit here; it was too small to show
     anything a farmer could actually recognise, and for something like
     "how to run a kiln" a picture carries more than the sentence next to
     it. All eight scenes sit on the same paddy-tint ground so the set
     reads as one place across the deck, not eight unrelated icons.
     Colours are the palette hex values directly (same convention as the
     dashboard/card CSS, just not reachable via var() on SVG attributes). */
  function trainingIllustration(name) {
    var svgns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgns, "svg");
    svg.setAttribute("viewBox", "0 0 300 150");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-hidden", "true");

    function shape(tag, attrs) {
      var n = document.createElementNS(svgns, tag);
      for (var k in attrs) { if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]); }
      svg.appendChild(n);
      return n;
    }

    shape("rect", { x: 0, y: 112, width: 300, height: 38, fill: "#EEF4E3" });

    var scenes = {
      /* Straw burning in the open: carbon drifting away as smoke, nothing
         left behind. */
      flame: function () {
        shape("path", { d: "M120 114 L150 70 L180 114 Z", fill: "#FCF2DF", stroke: "#96590A", "stroke-width": 2 });
        [128, 139, 150, 161, 172].forEach(function (x, i) {
          shape("line", { x1: x, y1: 112, x2: 150, y2: 80 - (i % 2) * 4, stroke: "#96590A", "stroke-width": 1.2, opacity: 0.5 });
        });
        shape("path", {
          d: "M150 44c9 12 15 18 15 27a15 15 0 0 1-30 0c0-6 3-9 6-12 0 6 3 9 6 9 0-9-3-15 3-24z",
          fill: "#B4451A"
        });
        shape("path", { d: "M156 40c6-10 2-18 8-26", fill: "none", stroke: "#756A5E", "stroke-width": 3, "stroke-linecap": "round", opacity: 0.45 });
        shape("path", { d: "M165 47c8-9 4-19 13-25", fill: "none", stroke: "#756A5E", "stroke-width": 3, "stroke-linecap": "round", opacity: 0.28 });
        shape("path", { d: "M173 55c10-6 8-17 19-21", fill: "none", stroke: "#756A5E", "stroke-width": 3, "stroke-linecap": "round", opacity: 0.15 });
      },
      /* Ash versus biochar: pale dust that blows away, next to solid dark
         chunks that hold together. */
      layers: function () {
        [[58, 96, 5], [74, 101, 4], [48, 106, 5], [66, 108, 4], [86, 92, 4], [96, 102, 5]].forEach(function (p) {
          shape("circle", { cx: p[0], cy: p[1], r: p[2], fill: "#E3DACB" });
        });
        shape("line", { x1: 150, y1: 55, x2: 150, y2: 112, stroke: "#E3DACB", "stroke-width": 2, "stroke-dasharray": "4 5" });
        shape("rect", { x: 200, y: 74, width: 22, height: 18, rx: 4, fill: "#4A4038" });
        shape("rect", { x: 183, y: 90, width: 34, height: 22, rx: 5, fill: "#241E18" });
        shape("rect", { x: 221, y: 98, width: 26, height: 16, rx: 4, fill: "#241E18" });
      },
      /* Gathering straw: some stalks left standing, one bundle tied and
         carried off. */
      stack: function () {
        [70, 82, 94, 106].forEach(function (x, i) {
          var lean = (i % 2) * 5;
          shape("path", {
            d: "M" + x + " 112 L" + x + " " + (80 - lean) + " Q " + (x + 5) + " " + (70 - lean) + " " + (x + 9) + " " + (76 - lean),
            stroke: "#96590A", "stroke-width": 2.4, fill: "none", "stroke-linecap": "round"
          });
        });
        shape("path", {
          d: "M205 112 C195 90 200 66 220 58 C240 66 245 90 235 112 Z",
          fill: "#FCF2DF", stroke: "#96590A", "stroke-width": 2
        });
        shape("line", { x1: 198, y1: 88, x2: 242, y2: 88, stroke: "#8A3413", "stroke-width": 3 });
      },
      /* The kiln running: straw fed in from the side, one steady flame,
         only a little smoke. */
      fire: function () {
        shape("ellipse", { cx: 150, cy: 70, rx: 30, ry: 7, fill: "#241E18" });
        shape("rect", { x: 120, y: 70, width: 60, height: 44, rx: 6, fill: "#4A4038" });
        shape("path", { d: "M96 54 L119 72", stroke: "#96590A", "stroke-width": 6, "stroke-linecap": "round", opacity: 0.75 });
        shape("path", { d: "M90 62 L112 78", stroke: "#96590A", "stroke-width": 6, "stroke-linecap": "round" });
        shape("path", {
          d: "M150 40c7 9 11 14 11 20a11 11 0 0 1-22 0c0-4 2-7 4-9 0 4 2 6 4 6 0-6-2-11 3-17z",
          fill: "#B4451A"
        });
        shape("path", { d: "M159 36c4-6 1-10 4-15", fill: "none", stroke: "#756A5E", "stroke-width": 2.2, "stroke-linecap": "round", opacity: 0.3 });
      },
      /* Stopping the burn at the right moment: water going onto the char
         while it is still dark, before it turns to ash. */
      drop: function () {
        shape("ellipse", { cx: 150, cy: 70, rx: 30, ry: 7, fill: "#241E18" });
        shape("rect", { x: 120, y: 70, width: 60, height: 44, rx: 6, fill: "#4A4038" });
        shape("path", {
          d: "M150 52c4 5 6 8 6 11a6 6 0 0 1-12 0c0-2 1-4 2-5 0 2 1 3 2 3 0-3-1-6 2-9z",
          fill: "#8A3413", opacity: 0.75
        });
        shape("path", {
          d: "M150 16c5 7 8 12 8 17a8 8 0 0 1-16 0c0-5 3-10 8-17z",
          fill: "#756A5E"
        });
        shape("path", { d: "M137 46c3-4 0-8 3-12", stroke: "#756A5E", "stroke-width": 2.2, fill: "none", "stroke-linecap": "round", opacity: 0.4 });
        shape("path", { d: "M163 46c-3-4 0-8-3-12", stroke: "#756A5E", "stroke-width": 2.2, fill: "none", "stroke-linecap": "round", opacity: 0.4 });
      },
      /* Working the biochar into the topsoil, and something growing from
         it afterwards. */
      sprout: function () {
        [[75, 125], [100, 133], [130, 121], [162, 131], [192, 123], [222, 134], [248, 119]].forEach(function (p) {
          shape("circle", { cx: p[0], cy: p[1], r: 3, fill: "#241E18", opacity: 0.55 });
        });
        shape("path", { d: "M150 112 L150 78", stroke: "#3F6B1E", "stroke-width": 3, "stroke-linecap": "round" });
        shape("path", { d: "M150 90c-4-10-16-12-22-8 3 11 14 14 22 8z", fill: "#3F6B1E" });
        shape("path", { d: "M150 82c4-10 16-12 22-8-3 11-14 14-22 8z", fill: "#3F6B1E" });
      },
      /* The kiln kept away from buildings, water within reach — the
         precautions, not the danger. */
      shield: function () {
        shape("ellipse", { cx: 61, cy: 86, rx: 17, ry: 4, fill: "#241E18" });
        shape("rect", { x: 44, y: 86, width: 34, height: 26, rx: 5, fill: "#4A4038" });
        shape("path", {
          d: "M61 66c4 5 6 8 6 11a6 6 0 0 1-12 0c0-2 1-4 2-5 0 2 1 3 2 3 0-3-1-6 2-9z",
          fill: "#B4451A"
        });
        shape("line", { x1: 90, y1: 112, x2: 150, y2: 112, stroke: "#756A5E", "stroke-width": 2, "stroke-dasharray": "3 5", opacity: 0.6 });
        shape("path", { d: "M170 92 L200 92 L195 116 L175 116 Z", fill: "#756A5E" });
        shape("path", { d: "M175 92c3-8 17-8 20 0", fill: "none", stroke: "#4A4038", "stroke-width": 2.4 });
        shape("path", {
          d: "M230 58l16 6v13c0 10-7 17-16 21-9-4-16-11-16-21V64z",
          fill: "none", stroke: "#B4451A", "stroke-width": 2.4
        });
        shape("path", {
          d: "M222 78l6 6 10-11", fill: "none", stroke: "#B4451A", "stroke-width": 2.4,
          "stroke-linecap": "round", "stroke-linejoin": "round"
        });
      },
      /* Photographing the whole heap, in daylight, not a close-up. */
      camera: function () {
        shape("circle", { cx: 245, cy: 34, r: 11, fill: "#96590A" });
        [0, 45, 90, 135, 180, 225, 270, 315].forEach(function (a) {
          var rad = a * Math.PI / 180;
          shape("line", {
            x1: 245 + Math.cos(rad) * 16, y1: 34 + Math.sin(rad) * 16,
            x2: 245 + Math.cos(rad) * 21, y2: 34 + Math.sin(rad) * 21,
            stroke: "#96590A", "stroke-width": 2, "stroke-linecap": "round"
          });
        });
        shape("path", { d: "M68 112 L148 112 L126 76 L90 76 Z", fill: "#FCF2DF", stroke: "#96590A", "stroke-width": 2 });
        shape("rect", { x: 178, y: 70, width: 70, height: 48, rx: 8, fill: "#241E18" });
        shape("rect", { x: 198, y: 58, width: 20, height: 14, rx: 3, fill: "#241E18" });
        shape("circle", { cx: 213, cy: 94, r: 16, fill: "#4A4038" });
        shape("circle", { cx: 213, cy: 94, r: 9, fill: "#1A1512" });
      }
    };

    (scenes[name] || scenes.layers)();
    return svg;
  }

  /* --- evidence --------------------------------------------------------- */

  function blankDraft() {
    return { photos: {}, gps: null, straw_kg: "", biochar_kg: "", result: null };
  }

  RENDER.evidence = function () {
    if (!state.draft) state.draft = blankDraft();
    $("#ev-title").textContent = "Batch " + (state.batches.length + 1);

    $$('.screen[data-screen="evidence"] .photo-slot').forEach(function (slot) {
      restorePhotoSlot(slot, state.draft.photos[slot.dataset.slot]);
    });

    $("#ev-straw").value = state.draft.straw_kg || "";
    $("#ev-biochar").value = state.draft.biochar_kg || "";
    updateYieldHint();

    if (state.draft.gps) {
      $("#ev-gps-status").textContent =
        "Location recorded: " + state.draft.gps.lat.toFixed(4) + ", " +
        state.draft.gps.lng.toFixed(4);
      $("#ev-gps-tick").hidden = false;
    } else {
      $("#ev-gps-status").textContent = "";
      $("#ev-gps-tick").hidden = true;
    }
    clearError($("#ev-err"));
    updateEvidenceProgress();
  };

  /* Five things make up a batch: three photos, one pair of weights, one
     GPS point. This is shown at the top of the long evidence form so the
     farmer can see how much is left without scrolling through everything
     already done — and completed cards get a paddy-green border so a
     glance down the page shows what still needs attention. */
  function updateEvidenceProgress() {
    var d = state.draft || blankDraft();
    var photosDone = ["straw", "kiln", "biochar"].filter(function (k) {
      return d.photos && d.photos[k];
    }).length;
    var weightsDone = !!(d.straw_kg && d.biochar_kg);
    var gpsDone = !!d.gps;
    var done = photosDone + (weightsDone ? 1 : 0) + (gpsDone ? 1 : 0);

    var el = $("#ev-progress");
    if (el) el.textContent = done + " of 5 ready";

    var weightCard = $(".weight-card");
    if (weightCard) weightCard.classList.toggle("is-done", weightsDone);
    var gpsCard = $(".gps-card");
    if (gpsCard) gpsCard.classList.toggle("is-done", gpsDone);
  }

  function restorePhotoSlot(slot, entry) {
    var img = $(".ps-preview", slot);
    var meta = $(".ps-meta", slot);
    var tick = $(".ps-tick", slot);
    var label = $(".file-btn span", slot);

    if (entry && entry.url) {
      img.src = entry.url;
      img.hidden = false;
      img.alt = "Photo you uploaded for this step";
      meta.hidden = false;
      meta.textContent = photoMetaText(entry);
      tick.hidden = false;
      slot.classList.add("is-done");
      if (label) label.textContent = "Replace photo";
    } else {
      img.hidden = true;
      img.removeAttribute("src");
      meta.hidden = true;
      tick.hidden = true;
      slot.classList.remove("is-done");
      if (label) label.textContent = "Take or choose photo";
    }
  }

  function photoMetaText(entry) {
    var bits = [
      entry.size_kb + " KB",
      new Date(entry.captured_at).toLocaleString("vi-VN", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
      })
    ];
    if (entry.is_duplicate) bits.push("Already submitted before");
    return bits.join(" \u00b7 ");
  }

  function updateYieldHint() {
    var straw = parseFloat($("#ev-straw").value);
    var char = parseFloat($("#ev-biochar").value);
    var hint = $("#ev-yield-hint");
    if (!straw || !char || straw <= 0 || char <= 0) {
      hint.textContent = "A kiln usually turns about a quarter of the straw into biochar.";
      return;
    }
    var pct = (char / straw) * 100;
    hint.textContent = pct.toFixed(0) + "% of the straw became biochar.";
  }

  RENDER.quality = function () {
    var r = state.draft && state.draft.result;
    if (!r) return;

    var icon = $("#qc-icon");
    icon.className = "result-icon " + (r.status === "ready" ? "icon-good" : "icon-warn");
    icon.textContent = r.status === "ready" ? "\u2713" : "!";

    $("#qc-title").textContent = r.headline;
    $("#qc-summary").textContent = r.summary;
    $("#qc-disclaimer").textContent = r.disclaimer;

    renderNoteBlock($("#qc-issues"), r.issues, "Please fix these", "callout-bad", "issue-list");
    renderNoteBlock($("#qc-warnings"), r.warnings, "Worth checking", "callout-warn", "warn-list");

    var sat = $("#qc-satellite");
    if (r.satellite) {
      sat.hidden = false;
      $("#qc-sat-head").textContent = r.satellite.headline;
      $("#qc-sat-detail").textContent = r.satellite.detail;
      $("#qc-sat-note").textContent = r.satellite.note;
    } else {
      sat.hidden = true;
    }

    var passed = $("#qc-passed");
    passed.innerHTML = "";
    (r.passed || []).forEach(function (p) { passed.appendChild(el("li", null, p)); });
    $("#qc-passed-wrap").hidden = (r.passed || []).length === 0;

    var primary = $("#btn-qc-primary");
    var secondary = $("#btn-qc-secondary");

    if (r.status === "ready") {
      primary.textContent = "Save this batch";
      primary.onclick = saveBatch;
      secondary.hidden = false;
      secondary.textContent = "Go back and change something";
      secondary.onclick = function () { go("evidence"); };
    } else {
      primary.textContent = "Go back and fix it";
      primary.onclick = function () { go("evidence"); };
      secondary.hidden = true;
    }
  };

  /* --- verification ----------------------------------------------------- */

  RENDER.verification = function () {
    var track = $("#v-track");
    track.innerHTML = "";
    VERIFY_STEPS.forEach(function (s, i) {
      if (s.key === "moreinfo" && state.verifyStep < 4) return;
      var li = el("li");
      if (i < state.verifyStep) li.classList.add("is-done");
      if (i === state.verifyStep) {
        li.classList.add("is-now");
        li.setAttribute("aria-current", "step");
      }
      li.appendChild(document.createTextNode(s.label));
      if (s.note) li.appendChild(el("span", "v-note", s.note));
      track.appendChild(li);
    });

    var dl = $("#v-package");
    dl.innerHTML = "";
    kv(dl, "Batches", String(state.batches.length));
    kv(dl, "Photos", String(state.batches.length * 3));
    kv(dl, "Biochar recorded", totalBiochar() + " kg");
    kv(dl, "Field ID", state.farm ? state.farm.farm_id : "\u2014", true);
    kv(dl, "Period", DEMO.verification_period);

    var btn = $("#btn-v-advance");
    var step = VERIFY_STEPS[state.verifyStep];

    if (!step) { btn.hidden = true; return; }
    btn.hidden = false;

    if (step.key === "moreinfo" && !state.moreInfoDone) {
      btn.textContent = "Upload the photo they asked for";
      btn.onclick = function () { go("more-evidence"); };
    } else if (step.key === "complete") {
      btn.textContent = "See my credits";
      btn.onclick = function () { finishVerification(); };
    } else {
      btn.textContent = "Continue";
      btn.onclick = function () { advanceVerification(); };
    }
  };

  /* --- issued / sale / payment ----------------------------------------- */

  RENDER.issued = function () {
    var s = state.season;
    if (!s) return;
    $("#iss-total").textContent = s.credits_total;
    $("#iss-now").textContent = s.credits_now;
    $("#iss-held").textContent = s.credits_held;
    $("#iss-safeguard").textContent = s.safeguard_note;
    $("#iss-context").textContent = s.context_note || "";

    var dl = $("#iss-record");
    dl.innerHTML = "";
    kv(dl, "Verification period", DEMO.verification_period);
    kv(dl, "Issuance date", DEMO.issuance_date);
    kv(dl, "Registry status", "Issued");
    kv(dl, "Serial number", DEMO.registry_serial, true);
    kv(dl, "Field ID", state.farm ? state.farm.farm_id : "\u2014", true);
    kv(dl, "Biochar recorded", s.biochar_kg + " kg");
  };

  RENDER.sale = function () {
    var track = $("#sale-track");
    track.innerHTML = "";
    SALE_STEPS.forEach(function (s, i) {
      var li = el("li");
      if (i < state.saleStep) li.classList.add("is-done");
      if (i === state.saleStep) {
        li.classList.add("is-now");
        li.setAttribute("aria-current", "step");
      }
      li.appendChild(document.createTextNode(s.label));
      if (s.note) li.appendChild(el("span", "v-note", s.note));
      track.appendChild(li);
    });

    $("#sale-buyer-card").hidden = state.saleStep < 2;

    var chain = $("#sale-chain");
    chain.innerHTML = "";
    CREDIT_CHAIN.forEach(function (c, i) {
      var li = el("li", null, c);
      if (i < state.saleStep) li.classList.add("is-done");
      if (i === state.saleStep) li.classList.add("is-now");
      chain.appendChild(li);
    });

    var btn = $("#btn-sale-advance");
    if (state.saleStep >= SALE_STEPS.length - 1) {
      btn.textContent = "See my payment";
      btn.onclick = completePayment;
    } else {
      btn.textContent = "Continue";
      btn.onclick = function () {
        state.saleStep = Math.min(state.saleStep + 1, SALE_STEPS.length - 1);
        var label = SALE_STEPS[state.saleStep].label;
        addUpdate(label + ".");
        save();
        RENDER.sale();
        toast(label);
      };
    }
  };

  RENDER.payment = function () {
    var s = state.season;
    if (!s) return;
    $("#pay-amount").textContent = dong(s.paid_out);

    var dl = $("#pay-details");
    dl.innerHTML = "";
    kv(dl, "Payment date", DEMO.payment_date);
    kv(dl, "Field", state.farm ? state.farm.field_name : "\u2014");
    kv(dl, "Credits sold", String(s.credits_now));
    kv(dl, "Buyer", DEMO.buyer);
    kv(dl, "Reference", DEMO.payment_reference, true);

    var advBox = $("#pay-advance-box");
    if (state.advance) {
      advBox.hidden = false;
      $("#pay-advance-note").textContent =
        "You took " + dong(state.advance.amount) + " early on " +
        state.advance.date + ". With the " +
        dong(state.advance.fee) + " service charge, " +
        dong(state.advance.total) + " was deducted from this payment.";
    } else {
      advBox.hidden = true;
    }

    $("#pay-held-note").textContent =
      s.credits_held + " credits are still held as a safeguard, worth about " +
      dong(s.held_value) + " to you. They are released after the next " +
      "review and paid to you then.";
  };

  /* --- terms ------------------------------------------------------------ */

  RENDER.terms = function () {
    var split = $("#terms-split");
    renderAllocation(split);

    var chain = $("#terms-chain");
    if (chain.childElementCount === 0) {
      [
        "How much straw your field produces each season.",
        "How much of it can be collected without harming your soil.",
        "How much biochar that straw makes in a kiln.",
        "How much carbon is in the biochar, and how much is still there in 100 years.",
        "Minus the emissions from collecting, transporting and running the kiln.",
        "Multiplied by the credit price, then your share of it."
      ].forEach(function (t) { chain.appendChild(el("li", null, t)); });
    }
  };

  function renderAllocation(container) {
    if (!container) return;
    container.innerHTML = "";
    var farmerShare = CONST.farmer_share_pct || 65;
    var rows = [
      { pct: farmerShare, label: "Farmer payment", detail: "paid to you", farmer: true },
      { pct: 14, label: "Independent verification", detail: "verification and registry" },
      { pct: 13, label: "Programme delivery", detail: "kilns, training and field staff" },
      { pct: 8, label: "Credit sale", detail: "finding buyers and managing the sale" }
    ];
    rows.forEach(function (r) {
      var li = el("li", r.farmer ? "is-farmer" : "");
      var main = el("div", "allocation-main");
      main.appendChild(el("strong", "allocation-label", r.label));
      main.appendChild(el("span", "allocation-detail", r.detail));
      li.appendChild(main);
      li.appendChild(el("strong", "allocation-value", r.pct + "%"));
      container.appendChild(li);
    });
  }

  /* ======================================================================
     ACTIONS
     ====================================================================== */

  function submitForVerification() {
    if (state.batches.length === 0) {
      toast("Record at least one batch first.");
      return;
    }
    setStage(5);
    state.verifyStep = 0;
    addUpdate("Your batches were sent for verification.");
    save();
    go("verification");
  }

  function advanceVerification() {
    state.verifyStep = Math.min(state.verifyStep + 1, VERIFY_STEPS.length - 1);
    var step = VERIFY_STEPS[state.verifyStep];
    addUpdate(step.label + ".");
    save();
    RENDER.verification();
    toast(step.label);
  }

  function finishVerification() {
    api("/api/season-summary", { batches: state.batches })
      .then(function (data) {
        state.season = {
          credits_total: data.credits_total,
          credits_now: data.credits_now,
          credits_held: data.credits_held,
          farmer_payment: data.farmer_payment,
          held_value: data.held_value,
          biochar_kg: data.biochar_kg,
          safeguard_note: data.safeguard_note,
          context_note: data.context_note,
          batch_count: data.batch_count,
          paid_out: 0
        };
        setStage(6);
        state.saleStep = 0;
        addUpdate("Credits issued: " + data.credits_total + ".");
        save();
        go("issued");
      })
      .catch(function (err) { toast(err.message); });
  }

  function completePayment() {
    var s = state.season;
    var deduction = advanceTaken();
    s.paid_out = Math.max(0, s.farmer_payment - deduction);
    setStage(7);
    addUpdate("Payment of " + dong(s.paid_out) + " sent to you.");
    save();
    go("payment");
  }

  function advanceTaken() {
    return state.advance ? state.advance.total : 0;
  }

  function saveBatch() {
    var d = state.draft;
    state.batches.push({
      date: nowLabel(),
      straw_kg: Number(d.straw_kg),
      biochar_kg: Number(d.biochar_kg),
      yield_pct: d.result ? d.result.yield_pct : null,
      photos: Object.keys(d.photos).map(function (k) {
        return { slot: k, id: d.photos[k].id };
      }),
      gps: d.gps
    });
    setStage(4);
    addUpdate("Batch " + state.batches.length + " passed the quality check.");
    state.draft = blankDraft();
    save();
    toast("Batch saved");
    go("dashboard");
  }

  function resetAll() {
    if (!confirm("This clears everything and starts the demo again. Continue?")) return;
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    state = clone(defaultState);
    estPractice = null;
    estSeasons = 2;
    eligAnswers = {};
    $("#elig-questions").innerHTML = "";
    $("#est-practice").innerHTML = "";
    go("landing", true);
    location.reload();
  }

  /* ======================================================================
     GEOLOCATION
     ====================================================================== */

  function locate(statusNode, onDone) {
    if (!navigator.geolocation) {
      statusNode.textContent =
        "This device cannot share its location. Enter it by hand below.";
      return;
    }
    statusNode.textContent = "Finding your location\u2026";
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        onDone(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      },
      function (err) {
        var msg;
        if (err.code === 1) {
          msg = "You did not allow location access. That is fine \u2014 " +
                "enter the location by hand below instead.";
        } else if (err.code === 3) {
          msg = "Finding your location took too long. Try again, or enter it by hand.";
        } else {
          msg = "Could not find your location. Enter it by hand below.";
        }
        statusNode.textContent = msg;
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }

  /* ======================================================================
     MAP
     ====================================================================== */

  var map = null;
  var marker = null;
  var boundaryPoints = [];
  var boundaryLayer = null;
  var mapMode = "quick";

  function initMap() {
    if (map || typeof L === "undefined") {
      if (typeof L === "undefined") $("#map-fallback").hidden = false;
      return;
    }
    try {
      map = L.map("map", { attributionControl: true })
        .setView([DEMO.field_lat || 30.9, DEMO.field_lng || 75.85], 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: "\u00a9 OpenStreetMap"
      }).addTo(map);

      map.on("click", function (e) {
        if (mapMode === "precise") {
          addBoundaryPoint(e.latlng.lat, e.latlng.lng);
        } else {
          setMarker(e.latlng.lat, e.latlng.lng);
        }
      });
    } catch (e) {
      $("#map-fallback").hidden = false;
    }
  }

  function setMarker(lat, lng) {
    $("#fm-lat").value = lat.toFixed(6);
    $("#fm-lng").value = lng.toFixed(6);
    clearError($("#fm-loc-err"));
    if (!map) return;
    if (marker) marker.setLatLng([lat, lng]);
    else marker = L.marker([lat, lng]).addTo(map);
    map.setView([lat, lng], Math.max(map.getZoom(), 15));
  }

  function addBoundaryPoint(lat, lng) {
    boundaryPoints.push([lat, lng]);
    drawBoundary();
  }

  function drawBoundary() {
    if (!map) return;
    if (boundaryLayer) { map.removeLayer(boundaryLayer); boundaryLayer = null; }
    if (boundaryPoints.length >= 2) {
      boundaryLayer = L.polygon(boundaryPoints, {
        color: "#B4451A", weight: 2, fillOpacity: 0.15
      }).addTo(map);
    } else if (boundaryPoints.length === 1) {
      boundaryLayer = L.circleMarker(boundaryPoints[0], {
        radius: 5, color: "#B4451A"
      }).addTo(map);
    }
    updateBoundaryStatus();
  }

  function updateBoundaryStatus() {
    var node = $("#boundary-status");
    var n = boundaryPoints.length;
    if (n === 0) { node.textContent = "No points marked yet."; return; }
    if (n < 3) {
      node.textContent = n + " point" + (n === 1 ? "" : "s") +
        " marked. Mark at least three to close the shape.";
      return;
    }
    var hectares = polygonHectares(boundaryPoints);
    node.textContent = n + " points marked. That is about " +
      hectares.toFixed(2) + " ha.";
    var sizeInput = $("#fm-size");
    farmUnit = "ha";
    $("#fm-unit-label").textContent = "ha";
    if (sizeInput && !sizeInput.value) sizeInput.value = hectares.toFixed(2);
  }

  /* Shoelace formula on a local equirectangular projection. Accurate enough
     for a field a few hundred metres across. */
  function polygonHectares(points) {
    if (points.length < 3) return 0;
    var latRad = points[0][0] * Math.PI / 180;
    var mPerDegLat = 111132.0;
    var mPerDegLng = 111320.0 * Math.cos(latRad);
    var area = 0;
    for (var i = 0; i < points.length; i++) {
      var j = (i + 1) % points.length;
      var x1 = points[i][1] * mPerDegLng, y1 = points[i][0] * mPerDegLat;
      var x2 = points[j][1] * mPerDegLng, y2 = points[j][0] * mPerDegLat;
      area += (x1 * y2 - x2 * y1);
    }
    return Math.abs(area / 2) / 10000;
  }

  /* ======================================================================
     ADVANCE PAYMENT
     ====================================================================== */

  var ADVANCE_MAX_SHARE = 0.5;
  var ADVANCE_FEE_RATE = 0.06;

  function expectedPayment() {
    if (state.season) return state.season.farmer_payment;
    if (state.estimate) return state.estimate.income_low;
    return 0;
  }

  function openAdvance() {
    var max = Math.floor(expectedPayment() * ADVANCE_MAX_SHARE / 100) * 100;
    if (max <= 0) {
      toast("There is nothing to advance yet.");
      return;
    }
    $("#adv-amount").max = max;
    $("#adv-amount").value = "";
    $("#adv-max").textContent =
      "You can take up to " + dong(max) + " now. That is half of the " +
      "lower end of what you are expected to earn.";
    $("#adv-summary").innerHTML = "";
    clearError($("#adv-err"));
    $("#advance-modal").hidden = false;
    $("#adv-amount").focus();
  }

  function updateAdvanceSummary() {
    var amount = parseFloat($("#adv-amount").value);
    var box = $("#adv-summary");
    box.innerHTML = "";
    if (!amount || amount <= 0) return;
    var fee = Math.round(amount * ADVANCE_FEE_RATE);
    var dl = el("dl", "kv");
    kv(dl, "You receive now", dong(amount));
    kv(dl, "Service charge", dong(fee));
    kv(dl, "Deducted at payment", dong(amount + fee));
    box.appendChild(dl);
    var note = el("p", "small",
      "If the credits sell for less than expected, you keep what you were " +
      "already paid. That risk is ours, not yours.");
    box.appendChild(note);
  }

  function confirmAdvance() {
    var amount = parseFloat($("#adv-amount").value);
    var max = Math.floor(expectedPayment() * ADVANCE_MAX_SHARE / 100) * 100;
    var err = $("#adv-err");

    if (!amount || amount <= 0) {
      showError(err, "Enter how much you need.");
      return;
    }
    if (amount > max) {
      showError(err, "That is more than the " + dong(max) + " available.");
      return;
    }
    var fee = Math.round(amount * ADVANCE_FEE_RATE);
    state.advance = {
      amount: amount,
      fee: fee,
      total: amount + fee,
      date: nowLabel()
    };
    addUpdate("Early payment of " + dong(amount) + " sent to you.");
    save();
    $("#advance-modal").hidden = true;
    toast("Early payment arranged");
    RENDER.dashboard();
  }

  /* ======================================================================
     WIRING
     ====================================================================== */

  function init() {
    /* Generic navigation buttons */
    document.addEventListener("click", function (e) {
      var t = e.target.closest("[data-go]");
      if (t) { e.preventDefault(); go(t.dataset.go); }
    });

    $("#btn-back").addEventListener("click", function () {
      if (history.length > 1) history.back();
      else go(fallbackScreen());
    });
    $("#btn-home").addEventListener("click", function () { go("dashboard"); });
    $("#btn-terms-back").addEventListener("click", function () {
      if (history.length > 1) history.back();
      else go(fallbackScreen());
    });
    $("#btn-reset").addEventListener("click", resetAll);

    /* --- estimator --- */
    $$("#est-seasons .seg").forEach(function (seg) {
      seg.addEventListener("click", function () {
        estSeasons = Number(seg.dataset.value);
        $$("#est-seasons .seg").forEach(function (s) {
          var on = s === seg;
          s.classList.toggle("is-on", on);
          s.setAttribute("aria-checked", on ? "true" : "false");
        });
      });
    });
    $$("#form-estimate [data-unit]").forEach(function (button) {
      button.addEventListener("click", function () {
        setEstimatorUnit(button.dataset.unit);
      });
    });

    $("#form-estimate").addEventListener("submit", function (e) {
      e.preventDefault();
      var sizeEl = $("#est-size");
      var sizeErr = $("#est-size-err");
      var practiceErr = $("#est-practice-err");
      clearError(sizeErr);
      clearError(practiceErr);

      var size = parseFloat(sizeEl.value);
      var bad = false;
      if (!sizeEl.value) {
        showError(sizeErr, "Enter how big your field is.");
        bad = true;
      } else if (isNaN(size) || size <= 0) {
        showError(sizeErr, "Field size must be more than zero.");
        bad = true;
      } else if (size > 500) {
        showError(sizeErr, "That is larger than this service covers. Contact us directly.");
        bad = true;
      }
      if (!estPractice) {
        showError(practiceErr, "Choose what happens to your straw today.");
        bad = true;
      }
      if (bad) return;

      var btn = $("#btn-estimate");
      busy(btn, true, "Calculating\u2026");
      var input = {
        farm_size: size,
        unit: estUnit,
        straw_practice: estPractice,
        seasons: estSeasons
      };

      api("/api/estimate", input)
        .then(function (data) {
          state.estimate = data;
          state.estimateInput = input;
          farmUnit = data.unit || "ha";
          save();
          go("estimate-result");
        })
        .catch(function (err) { showError(sizeErr, err.message); })
        .then(function () { busy(btn, false); });
    });

    /* --- signup --- */
    $("#form-signup").addEventListener("submit", function (e) {
      e.preventDefault();
      var nameEl = $("#su-name"), mobEl = $("#su-mobile");
      clearError($("#su-name-err"));
      clearError($("#su-mobile-err"));

      if (nameEl.value.trim().length < 2) {
        showError($("#su-name-err"), "Enter your name.");
        return;
      }
      var btn = $("#btn-send-otp");
      busy(btn, true, "Sending\u2026");
      api("/api/send-otp", { name: nameEl.value.trim(), mobile: mobEl.value.trim() })
        .then(function (data) {
          state.name = nameEl.value.trim();
          state.mobile = mobEl.value.trim();
          save();
          $("#otp-block").hidden = false;
          $("#su-otp").focus();
          toast(data.message);
        })
        .catch(function (err) { showError($("#su-mobile-err"), err.message); })
        .then(function () { busy(btn, false); });
    });

    $("#btn-verify-otp").addEventListener("click", function () {
      var code = $("#su-otp").value;
      clearError($("#su-otp-err"));
      var btn = $("#btn-verify-otp");
      busy(btn, true, "Checking\u2026");
      api("/api/verify-otp", { code: code })
        .then(function () {
          state.onboarded = true;
          save();
          go("consent");
        })
        .catch(function (err) { showError($("#su-otp-err"), err.message); })
        .then(function () { busy(btn, false); });
    });

    /* --- consent --- */
    $("#consent-check").addEventListener("change", function () {
      $("#btn-consent").disabled = !this.checked;
    });
    $("#btn-consent").addEventListener("click", function () {
      state.consented = true;
      save();
      go("farm");
    });

    /* --- farm registration --- */
    $$(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        mapMode = tab.dataset.tab;
        $$(".tab").forEach(function (t) {
          var on = t === tab;
          t.classList.toggle("is-on", on);
          t.setAttribute("aria-selected", on ? "true" : "false");
        });
        $("#precise-panel").hidden = (mapMode !== "precise");
        if (map) setTimeout(function () { map.invalidateSize(); }, 50);
      });
    });

    $("#btn-locate").addEventListener("click", function () {
      locate($("#locate-status"), function (lat, lng, acc) {
        setMarker(lat, lng);
        $("#locate-status").textContent =
          "Location set, accurate to about " + Math.round(acc) + " m. " +
          "Move the pin on the map if it is not quite right.";
      });
    });

    $("#btn-boundary-undo").addEventListener("click", function () {
      boundaryPoints.pop();
      drawBoundary();
      if (boundaryPoints.length === 0) updateBoundaryStatus();
    });
    $("#btn-boundary-clear").addEventListener("click", function () {
      boundaryPoints = [];
      drawBoundary();
      updateBoundaryStatus();
    });

    $("#form-farm").addEventListener("submit", function (e) {
      e.preventDefault();
      clearError($("#fm-name-err"));
      clearError($("#fm-size-err"));
      clearError($("#fm-loc-err"));

      var name = $("#fm-name").value.trim();
      var size = parseFloat($("#fm-size").value);
      var lat = parseFloat($("#fm-lat").value);
      var lng = parseFloat($("#fm-lng").value);
      var ownership = $("#fm-ownership .seg.is-on").dataset.value;

      var bad = false;
      if (name.length < 2) {
        showError($("#fm-name-err"), "Give this field a name.");
        bad = true;
      }
      if (!size || isNaN(size) || size <= 0) {
        showError($("#fm-size-err"), "Enter how big the field is.");
        bad = true;
      }
      if (isNaN(lat) || isNaN(lng)) {
        showError($("#fm-loc-err"),
          "Set the location \u2014 tap the map, use your current location, " +
          "or type the coordinates.");
        bad = true;
      }
      if (bad) return;

      api("/api/register-farm", {
        field_name: name,
        farm_size: size,
        unit: farmUnit,
        lat: lat,
        lng: lng,
        ownership: ownership,
        boundary: boundaryPoints
      })
        .then(function (data) {
          state.farm = data.farm;
          setStage(1);
          addUpdate("Field registered as " + data.farm.farm_id + ".");
          save();
          toast("Field saved");
          go("eligibility");
        })
        .catch(function (err) { showError($("#fm-loc-err"), err.message); });
    });

    /* --- eligibility --- */
    $("#form-eligibility").addEventListener("submit", function (e) {
      e.preventDefault();
      var missing = null;
      $$("#elig-questions .err").forEach(function (n) { clearError(n); });

      ELIGIBILITY_QUESTIONS.forEach(function (q) {
        if (!eligAnswers[q.id]) {
          var node = $('#elig-questions .err[data-for="' + q.id + '"]');
          showError(node, "Please answer this.");
          if (!missing) missing = node;
        }
      });
      if (missing) {
        missing.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }

      api("/api/check-eligibility", { answers: eligAnswers })
        .then(function (data) {
          state.eligibility = data;
          if (data.status !== "blocked") setStage(2);
          addUpdate("Eligibility review: " + data.headline.toLowerCase() + ".");
          save();
          go("eligibility-result");
        })
        .catch(function (err) { toast(err.message); });
    });

    $("#btn-elig-continue").addEventListener("click", function () {
      if (state.eligibility && state.eligibility.status === "blocked") {
        go("dashboard");
      } else {
        go("training");
      }
    });

    /* --- training --- */
    $("#btn-train-prev").addEventListener("click", function () {
      state.trainingIndex = Math.max(0, state.trainingIndex - 1);
      save();
      drawTraining();
    });
    $("#btn-train-next").addEventListener("click", function () {
      if (state.trainingIndex >= TRAINING.length - 1) {
        state.trainingDone = true;
        setStage(3);
        addUpdate("Training completed.");
        save();
        toast("Training complete");
        go("dashboard");
        return;
      }
      state.trainingIndex += 1;
      save();
      drawTraining();
    });

    /* --- evidence: photo slots --- */
    $$(".photo-slot").forEach(function (slot) {
      var input = $("input[type=file]", slot);
      input.addEventListener("change", function () {
        var file = input.files && input.files[0];
        if (!file) return;

        if (!/^image\//.test(file.type)) {
          toast("That is not an image. Use a photo.");
          input.value = "";
          return;
        }
        if (file.size > 8 * 1024 * 1024) {
          toast("That photo is too large. Keep it under 8 MB.");
          input.value = "";
          return;
        }

        var label = $(".file-btn span", slot);
        var prev = label.textContent;
        label.textContent = "Uploading\u2026";
        slot.classList.add("is-busy");

        apiUpload(file, slot.dataset.slot)
          .then(function (data) {
            var entry = data.photo;
            entry.is_duplicate = data.is_duplicate;
            if (slot.closest('[data-screen="evidence"]')) {
              if (!state.draft) state.draft = blankDraft();
              state.draft.photos[slot.dataset.slot] = entry;
              save();
            } else {
              slot.dataset.uploadedId = entry.id;
              slot.dataset.uploaded = JSON.stringify(entry);
            }
            restorePhotoSlot(slot, entry);
            if (slot.closest('[data-screen="evidence"]')) updateEvidenceProgress();
            if (data.is_duplicate) {
              toast("This is the same photo as one sent before.");
            }
          })
          .catch(function (err) {
            toast(err.message);
            label.textContent = prev;
          })
          .then(function () {
            slot.classList.remove("is-busy");
            input.value = "";
          });
      });
    });

    ["#ev-straw", "#ev-biochar"].forEach(function (sel) {
      $(sel).addEventListener("input", function () {
        if (!state.draft) state.draft = blankDraft();
        state.draft.straw_kg = $("#ev-straw").value;
        state.draft.biochar_kg = $("#ev-biochar").value;
        updateYieldHint();
        updateEvidenceProgress();
        save();
      });
    });

    $("#btn-ev-locate").addEventListener("click", function () {
      locate($("#ev-gps-status"), function (lat, lng, acc) {
        if (!state.draft) state.draft = blankDraft();
        state.draft.gps = { lat: lat, lng: lng, accuracy: acc };
        save();
        $("#ev-gps-status").textContent =
          "Location recorded, accurate to about " + Math.round(acc) + " m.";
        $("#ev-gps-tick").hidden = false;
        updateEvidenceProgress();
      });
    });

    $("#btn-ev-manual-loc").addEventListener("click", function () {
      var lat = parseFloat($("#ev-lat").value);
      var lng = parseFloat($("#ev-lng").value);
      if (isNaN(lat) || isNaN(lng)) {
        toast("Enter both numbers.");
        return;
      }
      if (!state.draft) state.draft = blankDraft();
      state.draft.gps = { lat: lat, lng: lng, accuracy: null };
      save();
      $("#ev-gps-status").textContent =
        "Location set by hand: " + lat.toFixed(4) + ", " + lng.toFixed(4);
      $("#ev-gps-tick").hidden = false;
      updateEvidenceProgress();
    });

    $("#form-evidence").addEventListener("submit", function (e) {
      e.preventDefault();
      clearError($("#ev-err"));

      var d = state.draft || blankDraft();
      var straw = parseFloat($("#ev-straw").value);
      var char = parseFloat($("#ev-biochar").value);

      if (isNaN(straw) || isNaN(char)) {
        showError($("#ev-err"), "Enter both weights before checking.");
        return;
      }

      var btn = $("#btn-ev-submit");
      busy(btn, true, "Checking\u2026");

      api("/api/check-evidence", {
        photos: d.photos,
        straw_kg: straw,
        biochar_kg: char,
        gps: d.gps || {},
        farm: state.farm || {}
      })
        .then(function (data) {
          state.draft.result = data;
          state.draft.straw_kg = straw;
          state.draft.biochar_kg = char;
          save();
          go("quality");
        })
        .catch(function (err) { showError($("#ev-err"), err.message); })
        .then(function () { busy(btn, false); });
    });

    /* --- additional evidence --- */
    $("#btn-me-submit").addEventListener("click", function () {
      var slot = $('[data-screen="more-evidence"] .photo-slot');
      clearError($("#me-err"));
      if (!slot.dataset.uploadedId) {
        showError($("#me-err"), "Add the photo the verifier asked for.");
        return;
      }
      state.moreInfoDone = true;
      state.verifyStep = VERIFY_STEPS.length - 1;
      addUpdate("Extra photo sent to the verifier.");
      save();
      toast("Sent to the verifier");
      go("verification");
    });

    /* --- issued --- */
    $("#btn-iss-continue").addEventListener("click", function () {
      state.saleStep = Math.max(state.saleStep, 1);
      save();
      go("sale");
    });

    /* --- payment --- */
    $("#btn-next-season").addEventListener("click", function () {
      state.seasonNumber += 1;
      state.stage = 3;
      state.batches = [];
      state.draft = blankDraft();
      state.verifyStep = 0;
      state.saleStep = 0;
      state.moreInfoDone = false;
      state.season = null;
      state.advance = null;
      addUpdate("Joined rice season " + state.seasonNumber + ".");
      save();
      toast("You are in for the next season");
      go("dashboard");
    });

    /* --- advance modal --- */
    $("#btn-advance-open").addEventListener("click", openAdvance);
    $("#adv-amount").addEventListener("input", updateAdvanceSummary);
    $("#btn-adv-confirm").addEventListener("click", confirmAdvance);
    $("#btn-adv-cancel").addEventListener("click", function () {
      $("#advance-modal").hidden = true;
    });
    $("#advance-modal").addEventListener("click", function (e) {
      if (e.target === this) this.hidden = true;
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("#advance-modal").hidden) {
        $("#advance-modal").hidden = true;
      }
    });

    /* --- routing --- */
    window.addEventListener("hashchange", route);

    if (!location.hash) {
      go(state.farm ? "dashboard" : "landing", true);
    }
    route();

    /* Map is only built once, the first time the farm screen is shown. */
    var mapReady = false;
    var origShow = show;
    window.addEventListener("hashchange", function () {
      if (currentScreen === "farm" && !mapReady) {
        mapReady = true;
        setTimeout(function () {
          initMap();
          if (map) map.invalidateSize();
        }, 60);
      } else if (currentScreen === "farm" && map) {
        setTimeout(function () { map.invalidateSize(); }, 60);
      }
    });
    if (currentScreen === "farm") {
      mapReady = true;
      setTimeout(initMap, 60);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
