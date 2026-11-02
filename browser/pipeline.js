// luma-autopilot — browser engine.
//
// Evaluated INSIDE a logged-in luma.com tab (Claude's javascript tool). It reads
// each queued event, decides whether it can be registered for from your
// profile, shows you the planned answers, and then registers through Luma's own
// web endpoint with your session cookies — the same call the "Register" button
// makes, just without the clicking.
//
// It expects three globals to be set first (bin/inject.mjs prints all of them
// together with this file so it can be evaluated as one blob):
//   window.__P   — profile.json
//   window.__CFG — config.json
//   window.__RUN — tonight's run id, e.g. '0930'
//
// All state lives in localStorage so it survives tab reloads and CDP timeouts:
//   __q<RUN>    ordered slug list          __cls<RUN>  classification per slug
//   __res<RUN>  registration result/slug   __hb<RUN>   heartbeat {state, at, ...}
//
// Status vocabulary (also used in state/reg-log.txt):
//   READY        can be registered from the profile alone
//   NEEDS-HUMAN  a required question needs a fact the profile does not have
//   ALREADY      you are already registered / pending / waitlisted
//   SKIP-ONLINE  virtual event            SKIP-PAID      no free ticket
//   SKIP-WOMEN   women-focused event      SKIP-RELEVANCE title matched a skip pattern
//   OUT-OF-REGION wrong timezone/city     MEMBERS-ONLY   free tier is membership-gated
//   CLOSED       registration not open    404            page gone
//   REGISTERED / WAITLIST / GATE / FAIL-* come back from the register call.

(function () {
  if (!window.__P || !window.__CFG) throw new Error('set window.__P and window.__CFG before evaluating pipeline.js');
  window.__RUN = window.__RUN || 'manual';
  const P = window.__P, CFG = window.__CFG;
  const F = (k) => { const v = (P.facts || {})[k]; return v === undefined ? null : v; };
  const POL = (k, d) => { const v = (P.policy || {})[k]; return v === undefined ? d : v; };

  // ---------- storage + heartbeat ----------
  const K = (n) => '__' + n + window.__RUN;
  const ls = (k, v) => {
    if (v === undefined) return JSON.parse(localStorage.getItem(k) || '{}');
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) { hb({ state: 'LS-FULL', err: String(e).slice(0, 80) }); throw e; }
  };
  const hb = (o) => localStorage.setItem(K('hb'), JSON.stringify(Object.assign({ at: Date.now() }, o)));
  // Worker-backed sleep: background tabs throttle setTimeout to ~1/min after a
  // few idle minutes, which silently slows the loop 6x. A Worker timer does not.
  const sleep = (ms) => new Promise((res) => {
    try {
      const b = new Blob(['onmessage=e=>setTimeout(()=>postMessage(1),e.data)']);
      const w = new Worker(URL.createObjectURL(b));
      w.onmessage = () => { w.terminate(); res(); };
      w.postMessage(ms);
    } catch (e) { setTimeout(res, ms); }
  });

  // ---------- patterns ----------
  const WOMEN = /\b(women|womxn|woman|female|ladies|girls?|she\/her|femme|mujeres|sisters?)\b/i;
  const WOMEN_DESC = /\b(women|womxn|female founders?|ladies|girls?) (only|in|who|founders|builders|leaders|network)|for women|women['’]s|womxn/i;
  const NON_LATIN = /[一-鿿぀-ヿ가-힯Ѐ-ӿ؀-ۿऀ-ॿ]/;
  const IRREL = (CFG.skipTitlePatterns || []).length ? new RegExp((CFG.skipTitlePatterns || []).join('|'), 'i') : /$^/;
  const ONLINE_TITLE = /\b(webinar|virtual|online|zoom|livestream|live stream|google meet|ms teams|twitter space|x space)\b/i;
  const OUT_CITY = (CFG.outOfRegionCities || []).length ? new RegExp('\\b(' + CFG.outOfRegionCities.join('|') + ')\\b', 'i') : /$^/;
  const REGION = new RegExp((CFG.regionWords || [P.city]).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

  // ---------- membership ----------
  // Whether you CURRENTLY belong to a group is a claim the profile has no fact for. Questions
  // these patterns recognize get no answer: a required one becomes NEEDS-HUMAN, an optional one
  // is left blank. A recognized PROSPECTIVE question ("would you like to join our community?")
  // is a preference, answered from policy.joinCommunities using only options that do not state
  // a membership status. These are label/option regexes, not a general language model.
  const NOT_MEMBERSHIP = /\b(team|staff|family|crew|board|committee|founding|cast|panel)[- ]?members?\b/g;
  const MEMBERSHIP = /\bmembers?\b|\bmembership|alumn|affiliat|belong(s|ing)? to|\bassociat(ed|ion)\b|part of (?:the |our |a |an |any |this )?[\w'& -]{0,30}?\b(community|group|club|network|program|cohort|accelerator|organi[sz]ation|society|chapter|fellowship|collective)/;
  const CURRENT_ASK = /\balready\b|\b(current|existing)(ly)?\b|\bare you (a |an )?(\w+ ){0,3}(members?|alumn\w*|affiliat\w*|part of)|\bwere you\b|\bmember(ship)? (id|number|status|level|tier|since)\b|\bnon-?members?\b|\byour (membership|affiliation)|which [^?]*\b(are you|do you belong)|\bdo you belong|\bhave you been\b/;
  const JOIN_INTENT = /\b(would you like|do you want|want|like|interested|keen|happy|open) (in |to )(join|becom|be added|be part|subscrib)|\b(join|joining) (our|the|this)\b|\bbecome a member|\bsign (me )?up\b|\bopt[- ]?in\b/;
  // Lowercase, straighten curly quotes (I’m → i'm), collapse whitespace.
  const plain = (s) => String(s).toLowerCase().replace(/[‘’ʼ`´]/g, "'").replace(/\s+/g, ' ').trim();
  // 'current' | 'prospective' | null (not a membership question).
  const membershipKind = (L) => {
    const l = plain(L).replace(NOT_MEMBERSHIP, ' ');
    if (!MEMBERSHIP.test(l)) return null;
    if (CURRENT_ASK.test(l)) return 'current';
    if (JOIN_INTENT.test(l)) return 'prospective';
    return 'current';
  };
  // Conservative: an option states a membership status (and is never used as consent to join)
  // if it says already/current/existing, or mentions member/alumni/part of/belong at all,
  // unless that mention is about becoming one ("Yes, I'd like to become a member").
  // "Yes, I’m a member", "Yes, a member" and "Not a member yet" all count as statements.
  const statesMembership = (o) => {
    const s = plain(o);
    if (/\balready\b|\bcurrent(ly)?\b|\bexisting\b/.test(s)) return true;
    return /\bmembers?\b|\bmembership\b|\balum\w*|\bpart of\b|\bbelong/.test(s) && !/\b(become|becoming|join|joining)\b|\bsign (me )?up\b/.test(s);
  };
  // Text fields that ask for your employer, matched on the whole label (not a substring), so
  // "Are you a member of our organization?" is still a membership question.
  const EMPLOYER_FIELD = /^(company|organi[sz]ation|employer|(professional|company) affiliation)$/;

  // ---------- read an event page ----------
  async function rd(slug) {
    for (let a = 0; a < 4; a++) {
      const r = await fetch('https://luma.com/' + slug, { credentials: 'include' });
      if (r.status === 429) { hb({ state: '429', slug }); await sleep(120000); continue; }
      if (r.status === 404) return { http: 404 };
      const html = await r.text();
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) return { http: r.status, err: 'nonext' };
      try { return { http: r.status, d: JSON.parse(m[1]).props.pageProps.initialData.data }; }
      catch (e) { return { http: r.status, err: 'parse' }; }
    }
    return { http: 429 };
  }

  // ---------- answering ----------
  const pick = (opts, res) => { for (const re of res) { const o = opts.find((x) => re.test(x)); if (o) return o; } return null; };
  const norm = (s) => String(s).toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, '');
  // option whose text contains the fact string ("2-10", "Seed", "Delaware C-Corp")
  const containsFact = (opts, fact) => fact == null ? null : (opts.find((o) => norm(o).includes(norm(fact))) || null);
  // option whose numeric range contains n ("21-25", "18-24", "25+", "under 18")
  const rangeFor = (opts, n) => {
    if (n == null) return null;
    for (const o of opts) {
      const s = norm(o);
      let m = s.match(/(\d+)-(\d+)/); if (m && n >= +m[1] && n <= +m[2]) return o;
      m = s.match(/(\d+)\+|over(\d+)|(\d+)ormore|(\d+)andup/); if (m) { const lo = +(m[1] || m[2] || m[3] || m[4]); if (n >= lo) return o; }
      m = s.match(/under(\d+)|below(\d+)|<(\d+)|lessthan(\d+)/); if (m) { const hi = +(m[1] || m[2] || m[3] || m[4]); if (n < hi) return o; }
    }
    return null;
  };
  const yesNo = (opts, v) => v == null ? null : (v ? pick(opts, [/^yes\b/i]) : pick(opts, [/^no\b|^n\/?a\b|not /i]));

  // Prospective "join us?" answer from policy. Options that claim existing membership are never
  // candidates; if no honest option fits, null leaves it for the human.
  const joinAnswer = (opts) => {
    const ok = opts.filter((o) => !statesMembership(o));
    return POL('joinCommunities', true)
      ? pick(ok, [/^yes\b|^sure\b|\bok\b|count me in|sign me up|add me/i, /maybe/i])
      : pick(ok, [/^no\b|not now|no thanks|not interested/i]);
  };

  // Every question goes through the rules below, including single-option ones: a lone option
  // is not consent to whatever it says.
  function ansOpt(L, opts, multiple) {
    const many = (arr) => { const a = arr.filter(Boolean); return a.length ? (multiple ? a : a[0]) : null; };
    if (/like to present|to present\??|present your|open to presenting/.test(L)) return POL('speakOrPitch', false) ? pick(opts, [/^yes\b/i]) : pick(opts, [/^no\b|not this time|not (interested|now)/i]);
    if (/expect to stay|stay for the/.test(L)) return pick(opts, [/maybe/i, /^yes\b/i]);
    if (/date of birth|\bdob\b/.test(L)) return null;
    if (/ai spend|spend per month|monthly spend|api usage|\bbudget\b/.test(L)) return null;
    if (/company size|number of employees|employees|headcount|how many people (work|are (at|in) your company)/.test(L)) return containsFact(opts, F('companySize'));
    if (/\bage\b|age range|how old/.test(L) && !/stage/.test(L)) return rangeFor(opts, F('age'));
    if (/y ?combinator|\byc\b/.test(L)) return F('yc') == null ? null : F('yc') ? (containsFact(opts, F('ycBatch')) || pick(opts, [/^yes\b/i])) : pick(opts, [/^n\/?a\b|not (a )?yc|^no\b|none/i]);
    { const mk = membershipKind(L); if (mk === 'current') return null; if (mk === 'prospective') return joinAnswer(opts); }
    if (/entity type|legal entity|incorporat|c-?corp/.test(L)) return containsFact(opts, F('entityType'));
    if (/sales team|team size|how many people are/.test(L)) return null;
    if (/coming with a team|have a team|team status|looking for (a )?team/.test(L)) return pick(opts, [/looking|open|match|solo|no team/i]);
    if (/need help with|what do you need|looking for help/.test(L)) return many([pick(opts, [/customer|partner/i]), F('raising') ? pick(opts, [/rais|fund/i]) : null]);
    if (/how can you help|help others|can you help/.test(L)) return many([pick(opts, [/product|technical|feedback/i])]);
    if (/hoping to get|get out of (the|this)|what brings you/.test(L)) return many([pick(opts, [/learn|engage/i]), pick(opts, [/meet|network/i])]);
    if (/which session|session\(s\)|which part|time slot|availability on|which (day|half)/.test(L)) return many([pick(opts, [/full day|^all\b|all of the above/i]), pick(opts, [/evening/i])]);
    if (/not a robot/.test(L)) return pick(opts, [/^yes\b/i]);
    if (/if you'?re a founder|which one applies|founder stage/.test(L)) return containsFact(opts, F('stage')) || pick(opts, [/pre-?seed\s*\/?\s*seed|^seed$/i]);
    if (/expecting .*hiring|hiring (this year|in the next|timeline|plans)|are you hiring|is (your|the) company hiring|company hiring/.test(L)) return F('hiring') == null ? null : (F('hiring') ? pick(opts, [/^yes\b/i, /soon/i]) : pick(opts, [/^no\b|not/i]));
    if (/how do you (currently )?use ai (for|while|when) (coding|building)/.test(L)) return pick(opts, [/most of my code/i, /single ai process/i, /dabbled|some/i]);
    if (/keep up with ai/.test(L)) return pick(opts, [/meetups/i, /twitter|x\b/i, /newsletter/i]);
    if (/what can .* help you with/.test(L)) return pick(opts, [/community|meet/i]);
    if (/gtm motion|go-to-market motion/.test(L)) return pick(opts, [/still figuring/i, /founder-led/i]);
    if (/where would you want it|slack or discord|which platform/.test(L)) return pick(opts, [/slack/i, /discord/i]);
    if (/have you registered for|already registered/.test(L)) return pick(opts, [/^no\b/i]);
    if (/company or project type|project type/.test(L)) return pick(opts, [/^app\b|software|\bai\b|web2/i, /other/i]);
    if (/employment status/.test(L)) return F('isFounder') ? pick(opts, [/founder|self-?employed|^other\b/i]) : pick(opts, [/full-time/i, /^other\b/i]);
    if (/coding tool/.test(L)) return pick(opts, [/claude code/i, /cursor/i, /other/i]);
    if (/^goal\??$|your goal/.test(L)) return pick(opts, [/build something new/i, /ship/i, /learn/i]);
    if (/how do you access llms/.test(L)) return pick(opts, [/^api\b/i]);
    if (/team members .* bring|how many .* bring/.test(L)) return pick(opts, [/just me/i, /^1$|^0$/]);
    if (/pathway/.test(L)) return pick(opts, [/showcase|technology|founder/i]);
    if (/^field\??$/.test(L)) return F('isFounder') ? pick(opts, [/founder/i]) : pick(opts, [/engineer|software|tech/i]);
    if (/familiar are you with|have you built (with|an?)|currently using|are you (currently )?using/.test(L)) return pick(opts, [/not currently|would love|heard of .* haven't|haven't used|^no\b|beginner|new to/i]);
    if (/country|nationality/.test(L)) return containsFact(opts, P.country) || pick(opts, [/united states|^usa?$|\bu\.?s\.?a?\b/i]);
    if (/founder or investor|investor or founder|founder\/investor/.test(L)) return F('isFounder') ? pick(opts, [/founder/i]) : F('isInvestor') ? pick(opts, [/investor/i]) : pick(opts, [/other|operator/i]);
    if (/last round|latest round|most recent round|last financing/.test(L)) return containsFact(opts, F('stage'));
    if (/expertise/.test(L)) return containsFact(opts, F('expertise')) || pick(opts, [/\bai\b|machine learning|software|engineer|tech/i, /other/i]);
    if (/^profession\??$|your profession|^occupation/.test(L)) return F('isFounder') ? pick(opts, [/founder|entrepreneur|ceo/i, /startup|operator/i, /other/i]) : pick(opts, [/engineer|technical|software/i, /other/i]);
    if (/are you a founder\??$|are you a startup founder/.test(L)) return yesNo(opts, F('isFounder')) || (F('isFounder') ? pick(opts, [/founder/i]) : null);
    if (/full[- ]time on your startup|full[- ]time founder|working on (this|your startup) full/.test(L)) return yesNo(opts, F('fullTime')) || (F('fullTime') ? pick(opts, [/full/i]) : null);
    if (/self.?funded|how (are you|is your company) funded|funding (source|type)/.test(L)) return containsFact(opts, F('fundingType'));
    if (/attended before|returning|been (here|to one|to this) before/.test(L)) return pick(opts, [/^no\b|first/i]);
    if (/how will you (be )?(join|attend)|in[- ]person or (virtual|online|remote)/.test(L)) return pick(opts, [/in[- ]?person|irl|on[- ]?site/i]);
    if (/are you a student/.test(L)) return yesNo(opts, F('isStudent')) || pick(opts, [/not a student/i]);
    if (/united states resident|us resident|u\.s\. resident/.test(L)) return P.country ? yesNo(opts, /united states/i.test(P.country)) : null;
    if (/are you (an? )?(investor|vc|angel)|investor status|accredited|investing/.test(L)) return F('isInvestor') ? pick(opts, [/^yes\b|investor/i]) : pick(opts, [/^no\b|not an? investor|^n\/?a\b|not applicable|founder|operator|other/i]);
    if (/fundrais|raising (a |your )?(round|capital)|currently raising|rais(e|ing) (in|within|over) the next|plan(ning)? to raise/.test(L)) return F('raising') == null ? null : (F('raising') ? pick(opts, [/^yes\b|currently|actively|raising now|in the next/i]) : pick(opts, [/^no\b|not/i]));
    if (/education|degree/.test(L)) return containsFact(opts, F('education'));
    if (/salary|compensation|income/.test(L)) return null;
    if (/raised|funding amount|how much.*(raise|fund)/.test(L)) return containsFact(opts, F('totalRaised'));
    if (/\bmrr\b|monthly recurring|\barr\b|revenue/.test(L)) return containsFact(opts, F('revenue'));
    if (/stage/.test(L)) return containsFact(opts, F('stage')) || (F('stage') ? pick(opts, [/early/i]) : null);
    if (/(how|where) did you (hear|find|learn)|referr|source/.test(L)) return pick(opts, [/luma/i, /social/i, /linkedin/i, /other/i, /friend/i]);
    if (/diet|allerg|food|meal/.test(L)) return containsFact(opts, F('dietary')) || pick(opts, [/none|no (dietary|restriction)|no restrictions|omnivore|everything|n\/a/i]);
    if (/citizen|visa|work authori|immigration status/.test(L)) return containsFact(opts, F('citizenship'));
    if (/gender/.test(L)) return containsFact(opts, F('gender'));
    if (/pronoun/.test(L)) return containsFact(opts, F('pronouns'));
    if (/(ai|claude|cursor|copilot|tool|coding).*(experience|familiar|use|often)|how often|experience level|proficien/.test(L)) return pick(opts, [/daily|every day|advanced|expert|power user|regularly|frequently/i, /intermediate|some/i]);
    if (/first time/.test(L)) return pick(opts, [/^yes/i, /first/i]);
    if (/industr|sector|vertical|domain|space/.test(L)) return containsFact(opts, F('industry')) || pick(opts, [/\bai\b|artificial|machine learning|software|saas|\btech(nology)?\b/i, /other/i]);
    if (/(where|city|location|based|region).*(based|live|located|from|located|are you)|^location|^city|^where/.test(L)) return pick(opts, [REGION]);
    if (/stanford|berkeley|harvard|\bmit\b|universit|college|campus|alumn|\biit\b/.test(L)) return null;
    // "(corporate VCs only)" gates on a role you probably do not hold. Membership questions
    // ("+1 of a member?") never reach here; membershipKind() above sends them to the human.
    if (/\+\s?1 of|(corporate vcs?|investors?|lps?) only/.test(L)) return pick(opts, [/^no\b/i]);
    if (/all that apply|check all|select all/.test(L)) { const o = pick(opts, [/^startup$/i, /founder/i, /^other/i]); if (o) return multiple ? [o] : o; }
    if (/best describes? (you|your role)|describes? you|describe yourself|which of these are you|who are you|^role|your role|title|what do you do|i am a|category|attending as|type of attendee|persona|profile/.test(L)) {
      const o = F('isFounder') ? pick(opts, [/^(founder|co-?founder|ceo|entrepreneur)\b/i, /founder|co-?founder|ceo|entrepreneur/i, /^startup$/i]) : null;
      // Do not take a role option that also claims a vertical, a raise or a revenue figure you never stated
      // ("Deep tech founder who has raised at least $5M" is an eligibility claim, not a role).
      if (o && !/robotic|physical ai|hardware|deep ?tech|biotech|health|fintech|crypto|web3|climate|defen[cs]e|gaming|academia|research|\$|raised|at least|\d+\s?[mk]\+?\b|arr|mrr/i.test(o)) return o;
      return pick(opts, [/operator|builder/i, /engineer|technical/i, /^other$/i, /other/i]);
    }
    if (/age|birth|t-?shirt|size|grade|school|student|major|campus/.test(L)) return null;
    if (/open to (new )?(roles|opportunit|jobs)|looking for (a )?(job|role|work)|job search|hiring status|actively looking/.test(L)) return pick(opts, [/^no\b|not (looking|open)|founder|not actively/i]);
    if (/evaluate|free trial|\bpoc\b|proof of concept|book a (demo|call)|sales (call|demo)/.test(L)) return POL('vendorDemos', false) ? pick(opts, [/^yes\b/i]) : pick(opts, [/^no\b|not (now|interested|at this time)|maybe later|just (here|attending)/i]);
    if (/roast|demo|pitch(ing)?( at| your)?|speak(er|ing)|sponsor|volunteer|present|showcase|perform|table|booth/.test(L)) return POL('speakOrPitch', false) ? pick(opts, [/^yes\b/i]) : pick(opts, [/^no\b|not (interested|now|this time)|just attend|attendee|no thanks/i]);
    if (/interested in joining|join (our|the)|follow|subscribe|newsletter|updates|whatsapp|discord|slack|telegram|community|group|mailing/.test(L)) return joinAnswer(opts);
    if (/\+\s?1|plus[- ]one|bringing a guest|bring a guest/.test(L)) return POL('bringGuest', false) ? pick(opts, [/^yes\b/i]) : pick(opts, [/^no\b/i]);
    if (/consent|agree|acknowledge|confirm|understand|accept|terms|photo|film|record|waiver|liability|code of conduct|commit|attend|rsvp|show up|will you/.test(L)) return POL('agreeToTerms', true) ? pick(opts, [/^yes\b|i agree|agree|accept|ok|confirm|i will|understand|acknowledg/i]) : null;
    // Acknowledgement prompts: take the acknowledging option itself, not whichever comes first.
    if (opts.length <= 2 && POL('agreeToTerms', true)) { const o = pick(opts, [/\bok(ay)?!?$|got it|sounds good/i]); if (o) return o; }
    if (/interest|topic|track|session|theme|excited|hope to|goal|want to/.test(L)) return pick(opts, [/\bai\b|founder|startup|network|meet|build|all of the above|all/i, /other/i]);
    if (/yes|no/i.test(opts.join('|')) && opts.length <= 3 && /would you like|do you want|are you interested|can we|may we/.test(L)) return pick(opts, [/^yes/i]);
    return null;
  }

  function ansText(L) {
    const host = (P.website || '').replace(/^https?:\/\//, '');
    if (/are you a student/.test(L)) return F('isStudent') == null ? null : (F('isStudent') ? 'Yes' : 'No');
    if (/date of birth|\bdob\b/.test(L)) return null;
    if (/role.*hiring for|hiring for\b|roles? are you hiring/.test(L)) return null;
    if (/how many people|headcount|number of employees|employees at your company|company size|team size/.test(L)) return /sales|engineering|marketing/.test(L) ? null : F('companySize');
    if (/\bzip\b|postal/.test(L)) return P.zip || null;
    if (/instagram|\binsta\b/.test(L)) return P.instagram || null;
    if (/discord/.test(L) && /handle|username|user ?name|tag|id\b/.test(L)) return P.discord || null;
    if (/y ?combinator|\byc\b batch|yc batch/.test(L)) return F('yc') == null ? null : F('yc') ? (F('ycBatch') || null) : 'N/A — not a YC company';
    {
      // Recognized current-membership questions get no answer. The one exception is a bare
      // employer field ("Professional affiliation"), which gets company and title below.
      const mk = membershipKind(L);
      if (mk === 'current' && !EMPLOYER_FIELD.test(plain(L).replace(/[\s:?*.]+$/, ''))) return null;
      if (mk === 'prospective') return POL('joinCommunities', true) ? 'Yes' : 'No';
    }
    if (/entity type|legal entity|incorporat/.test(L)) return F('entityType');
    if (/when did .*(round|raise).*(close)|round clos(e|ed)|date of (last|most recent) (round|raise)/.test(L)) return F('lastRoundDate');
    if (/^age\??$|your age|how old/.test(L)) return F('age') == null ? null : String(F('age'));
    if (/referral contact|who is your (referral|contact) at/.test(L)) return null;
    if (/where did you (learn|hear|find)|where do you hear/.test(L)) return 'Luma';
    if (/who shared|shared this (event|invite)|^invited by/.test(L)) return 'Found the event on Luma';
    if (/linked-in/.test(L)) return 'https://www.linkedin.com' + P.linkedin;
    if (/what is your role\??\s*\(if student/.test(L)) return P.title;
    if (/like the demo|want a demo|would like a demo/.test(L)) return null;
    if (/giving a talk|give a talk|interested in (speaking|presenting)|be a speaker|speak(ing)? at (this|the|our)/.test(L)) return POL('speakOrPitch', false) ? null : 'No — just attending this time.';
    if (/learn more about pitch|interested in pitching|like to pitch/.test(L)) return POL('speakOrPitch', false) ? null : 'No';
    if (/who referred you|referred by\?|name the person that referred|person who referred/.test(L)) return 'No referral — found the event on Luma';
    if (/career description|one line career|^career\b/.test(L)) return P.title + ' of ' + P.company + (host ? ' (' + host + ')' : '');
    if (/what do you want to build|what will you build|what are you (going to|planning to) build|build with/.test(L)) return 'A prototype for ' + P.company + (host ? ' (' + host + ')' : '') + ' — happy to adapt to the sponsor stack.';
    if (/coming with a team|have a team|teammates|looking for (a )?team/.test(L)) return 'Solo for now — open to being matched with a team.';
    if (/returning|been (here|to one|to this) before|attended before/.test(L)) return 'No';
    if (/consent|opt[- ]in|listserv|mailing list/.test(L) && /yes\s*\/\s*no|\(yes|yes or no/.test(L)) return POL('joinCommunities', true) ? 'Yes' : 'No';
    if (/professional affiliation|^affiliation/.test(L)) return P.title + ', ' + P.company;
    if (/(company|organi[sz]ation) and (your )?role|role and company|where do you work.*role|work, and what/.test(L)) return P.title + ', ' + P.company;
    if (/approach(es)? evaluation|evals? today|how (does )?your team (approach|evaluate|handle)/.test(L)) return null;
    if (/engineering topics|topics .* (chat|discuss)|what topics/.test(L)) return 'AI agents, LLM infrastructure, and building with small teams';
    if (/planning to attend|will you (be )?attend|are you attending/.test(L)) return 'Yes';
    if (/partner\/co-host|co-host|be a speaker|sponsor this|venue host/.test(L)) return 'No — just attending this time.';
    if (/who else .* invite|who should we invite|who .* should we invite|want us to invite|(someone|anyone) (you|we) (would like|want) to invite|like to invite/.test(L)) return 'N/A';
    if (/tell us more.*(founder|company|stage)|based on your answer/.test(L)) return P.blurb;
    if (/explain why you would like to join|why (would|do) you (like|want) to (join|attend)/.test(L)) return P.blurb;
    if (/how('d| did) you (hear|find)/.test(L)) return 'Luma';
    if (/gtm problem|go-to-market problem/.test(L)) return null;
    if (/trading experience/.test(L)) return null;
    if (/alumn|did you have at|were you at|which (iit|university|school|college)/.test(L)) return null;
    if (/company or school|school or company|company\s*\/\s*school/.test(L)) return P.company;
    if (/founder or investor|investor or founder/.test(L)) return F('isFounder') ? 'Founder' : F('isInvestor') ? 'Investor' : null;
    if (/self.?funded|how (are you|is your company) funded|funding (source|type)/.test(L)) return F('fundingType');
    if (/^profession\??$|your profession|^occupation/.test(L)) return P.title;
    if (/\btitle\b/.test(L) && !/poster|talk|session|presentation|book|film/.test(L)) return P.title;
    if (/\bhq\b|headquarter/.test(L)) return P.city;
    if (/one[- ]line(r)?|short description|brief description|description of (your|the) (company|startup|product)/.test(L)) return P.blurb;
    if (/last round|latest round|most recent round|last financing/.test(L)) return F('stage');
    if (/area of expertise|your expertise/.test(L)) return F('expertise');
    if (/industry segment|which industry|your industry|sector/.test(L)) return F('industry');
    if (/full[- ]time on your startup|full[- ]time founder/.test(L)) return F('fullTime') == null ? null : (F('fullTime') ? 'Yes' : 'No');
    if (/linkedin/.test(L) && !/willing to share|would you (be )?(willing|ok|happy)|may we share|can we share|consent to shar/.test(L)) return P.linkedin ? 'https://www.linkedin.com' + P.linkedin : null;
    if (/if you said yes above|if you answered yes above/.test(L)) return null;
    if (/github/.test(L) && !/link|url|site|demo|building/.test(L)) return P.github || null;
    if (/twitter|\bx\b handle|x\.com|x profile/.test(L)) return P.twitter ? '@' + P.twitter : null;
    if (/instagram|insta\b|tiktok|snap|zip|postal|code\b|password|passcode|promo|coupon|invite code|referral code/.test(L)) return null;
    if (/student|school|university|grade|major|campus|gpa|graduat/.test(L)) return null;
    if (/company (email|domain|website|url|site)|work email/.test(L)) return /email/.test(L) ? P.email : (P.website || null);
    if (/website|domain|url|\blink\b|portfolio|site/.test(L)) return P.website || null;
    if (/e-?mail/.test(L)) return P.email;
    if (/phone|whatsapp|mobile|\bcell\b|(contact|mobile|cell) number/.test(L)) return P.phone || null;
    if (/first name/.test(L)) return P.first;
    if (/last name|surname/.test(L)) return P.last;
    if (/full name|your name|^name$/.test(L)) return P.first + ' ' + P.last;
    if (/job title|^title|your title|\brole\b|position|designation|what do you do|occupation|function/.test(L)) return P.title;
    if (/launch date|founded|founding (year|date)|when (was|did) .*(start|found|launch)|year founded|inception/.test(L)) return null;
    if (/company|employer|organi[sz]ation|startup( name)?|where do you work|who do you work|firm|business name|venture|project name/.test(L)) return P.company;
    if (/city and country|city, country|city\/country/.test(L)) return P.city + (P.country ? ', ' + P.country : '');
    if (/country|nationality/.test(L)) return P.country || null;
    if (/are you (an? )?(investor|vc|angel)|investor status|accredited/.test(L)) return F('isInvestor') ? 'Yes' : 'No';
    if (/fundrais|raising (a |your )?(round|capital)|currently raising|rais(e|ing) (in|within|over) the next/.test(L)) return F('raising') == null ? null : (F('raising') ? 'Yes, currently raising' : 'No');
    if (/dietary|allerg/.test(L)) return F('dietary');
    if (/citizen|visa|work authori/.test(L)) return F('citizenship');
    if (/salary|compensation/.test(L)) return null;
    if (/education|degree/.test(L)) return F('education');
    if (/how much.*(rais|fund)|raised|funding (raised|amount)|total (raised|funding)/.test(L)) return F('totalRaised');
    if (/\barr\b|revenue|\bmrr\b/.test(L)) return F('revenue');
    if (/stage/.test(L)) return F('stage');
    if (/(city|where).*(based|live|located|from|coming)|^location|^city|based in|hometown|where are you/.test(L)) return P.city;
    if (/how did you (hear|find|learn)|referr|who invited|who told/.test(L)) return 'Luma';
    if (/team size|employees|headcount|how many people|company size|age|birth|gender|pronoun|t-?shirt|member id|badge|ticket number|order number|confirmation/.test(L)) return null;
    if (/what (are you|do you) (build|work)|about (you|your company|yourself)|describe|tell us|introduce|bio|background|why (do you want|are you interested|would you like|should)|what do you hope|looking (forward|to get)|excited|goal|interest|expect|what brings|question(s)? for|anything else|comment|note|topic|challenge|problem|superpower|creative|most|one person|meet|advice|learn|share|fun fact|hobby|favorite|favourite|ideal|dream/.test(L)) return P.blurb;
    return null;
  }

  // ---------- classify one event into a plan ----------
  function plan(d) {
    const ev = d.event || {};
    const name = ev.name || '';
    const hosts = (d.hosts || []).map((h) => h.name).join(' ');
    const cal = (d.calendar || {}).name || '';
    const desc = JSON.stringify(d.description_mirror || '');
    const gd = d.guest_data || {};
    // guest_data is a stub even when not registered — test approval_status, not existence.
    if (gd.approval_status && gd.approval_status !== 'invited') return { cls: 'ALREADY', gs: gd.approval_status };
    if (CFG.skipWomenFocused !== false && (WOMEN.test(name + ' ' + hosts + ' ' + cal) || WOMEN_DESC.test(desc))) return { cls: 'SKIP-WOMEN' };
    if ((ev.timezone || '') !== CFG.timezone) return { cls: 'OUT-OF-REGION', tz: ev.timezone };
    if (CFG.noOnline !== false && ((ev.location_type && ev.location_type !== 'offline') || (!ev.geo_address_info && (ev.zoom_meeting_url || ev.virtual_info)) || ONLINE_TITLE.test(name))) return { cls: 'SKIP-ONLINE', lt: ev.location_type || null };
    { const addr = JSON.stringify(ev.geo_address_info || {}); const m = addr.match(OUT_CITY); if (m) return { cls: 'OUT-OF-REGION', tz: 'city:' + m[0] }; }
    if (IRREL.test(name) || (CFG.skipNonLatinTitles !== false && NON_LATIN.test(name))) return { cls: 'SKIP-RELEVANCE' };
    if ((CFG.skipSlugs || []).includes(ev.url)) return { cls: 'SKIP-RELEVANCE', why: 'skipSlugs' };
    const tts = (d.ticket_types || []).filter((t) => !t.is_hidden && !t.is_disabled);
    const free = tts.filter((t) => t.type === 'free' && !t.membership_restriction);
    if (!free.length) {
      if (tts.some((t) => t.membership_restriction)) return { cls: 'MEMBERS-ONLY' };
      if (tts.length) return { cls: 'SKIP-PAID' };
      return { cls: 'CLOSED', why: 'no tickets' };
    }
    const avail = d.registration_availability; const wl = !!d.waitlist_active;
    if (avail === 'sold-out' && !wl) return { cls: 'CLOSED', why: 'sold-out no waitlist' };
    if (avail && avail !== 'open' && avail !== 'sold-out') return { cls: 'CLOSED', why: avail };
    const answers = []; const needs = [];
    for (const q of (d.registration_questions || [])) {
      const L = (q.label || '').toLowerCase(); const t = q.question_type; let v = null;
      if (t === 'company') v = { company: P.company, job_title: P.title };
      else if (t === 'linkedin') v = P.linkedin || null;                 // path form: /in/handle
      else if (t === 'phone-number' || t === 'phone') v = P.phone || null; // E.164
      else if (t === 'email') v = P.email;
      else if (t === 'website') v = P.website || null;
      else if (t === 'terms' || t === 'agree-check' || t === 'checkbox') {
        // A checkbox that attests membership ("I confirm I am a current member") is a claim, not terms.
        const mk = membershipKind(L);
        const allowed = mk === 'current' ? false : mk === 'prospective' ? POL('joinCommunities', true) : POL('agreeToTerms', true);
        if (!q.required) continue;
        if (allowed) v = true;
      }
      else if (t === 'select' || t === 'multi-select' || t === 'dropdown') { const o = ansOpt(L, q.options || [], q.multiple); if (o) v = Array.isArray(o) ? o : [o]; }
      else if (t === 'url') { v = ansText(L); if (v === null && !/instagram|code|zip/.test(L)) v = P.website || null; }
      else if (t === 'text' || t === 'long-text' || t === 'textarea' || t === 'number') { v = ansText(L); if (t === 'number' && v && !/^\d+$/.test(String(v))) v = null; }
      else if (t === 'social') v = ansText(L) || (P.linkedin ? 'https://www.linkedin.com' + P.linkedin : null);
      else if (t === 'github') v = P.github || null;
      else if (t === 'twitter') v = P.twitter || null;
      if (v === null || v === undefined) { if (q.required) needs.push((q.label || t).slice(0, 90)); continue; }
      answers.push({ value: v, label: q.label, question_id: q.id, question_type: (t === 'select' || t === 'dropdown') ? 'multi-select' : t });
    }
    if (needs.length) return { cls: 'NEEDS-HUMAN', needs, name, api: d.api_id, qs: (d.registration_questions || []).map((q) => ({ id: q.id, t: q.question_type, req: !!q.required, l: (q.label || '').slice(0, 160), o: (q.options || []).slice(0, 12), m: !!q.multiple })) };
    const phone = (d.phone_number_requirement && d.phone_number_requirement !== 'off') ? (P.phone || null) : null;
    if (d.phone_number_requirement && d.phone_number_requirement !== 'off' && !phone) return { cls: 'NEEDS-HUMAN', needs: ['phone number (required by event)'], name, api: d.api_id };
    return { cls: 'READY', api: d.api_id, tt: free[0].api_id, answers, forWaitlist: !!(d.sold_out || avail === 'sold-out'), phone, name, start: ev.start_at, req: !!free[0].require_approval };
  }

  // ---------- the register call ----------
  async function post(slug, p) {
    const body = {
      name: P.first + ' ' + P.last, first_name: P.first, last_name: P.last, email: P.email,
      event_api_id: p.api, for_waitlist: !!p.forWaitlist, payment_method: null, payment_currency: null,
      registration_answers: p.answers, coupon_code: null, token_gate_info: null, eth_address_info: null,
      phone_number: p.phone || null, solana_address_info: null, expected_amount_cents: 0, expected_amount_tax: null,
      currency: null, event_invite_api_id: null, ticket_type_to_selection: { [p.tt]: { count: 1, amount: 0 } },
      solana_address: null, solana_wallet_type: null, opened_from: null,
    };
    const r = await fetch('https://api.luma.com/event/register', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-luma-client-type': 'luma-web', 'x-luma-timezone': CFG.timezone, 'x-luma-web-url': 'https://luma.com/' + slug, 'accept-language': 'en-US,en;q=0.9' },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    return { code: r.status, msg: txt.slice(0, 300) };
  }

  // ---------- loops ----------
  // Reads every queued slug, ~3s apart (faster gets HTTP 429). Fire-and-forget; poll __status().
  window.__classifyRun = async function () {
    const q = ls(K('q')); const out = ls(K('cls')); let i = 0;
    if (!Array.isArray(q)) throw new Error('localStorage ' + K('q') + ' must be a JSON array of slugs');
    for (const slug of q) {
      i++; if (out[slug] && out[slug].cls !== 'ERR') continue;
      hb({ state: 'CLS', slug, i, n: q.length });
      try {
        const r = await rd(slug);
        if (r.http === 404) out[slug] = { cls: '404' };
        else if (!r.d) out[slug] = { cls: 'ERR', http: r.http, err: r.err };
        else out[slug] = plan(r.d);
      } catch (e) { out[slug] = { cls: 'ERR', err: String(e).slice(0, 80) }; }
      ls(K('cls'), out); await sleep(2700);
    }
    hb({ state: 'CLS-DONE', n: q.length }); return 'done';
  };

  window.__doOne = async function (slug) {
    const c = ls(K('cls'))[slug];
    if (!c || c.cls !== 'READY') return { slug, st: 'NOT-READY' };
    const r = await post(slug, c); let st;
    if (r.code === 200 || r.code === 201) st = c.forWaitlist ? 'WAITLIST' : 'REGISTERED';
    else if (/already/i.test(r.msg)) st = 'ALREADY';
    else if (/additional-verification/.test(r.msg)) st = 'GATE';
    else if (/sold out/i.test(r.msg) && !c.forWaitlist) st = 'FAIL-ticket-sold-out';
    else if (/disabled/i.test(r.msg)) st = 'FAIL-disabled';
    else if (/blocked/i.test(r.msg)) st = 'FAIL-blocked';
    else st = 'FAIL';
    return { slug, st, code: r.code, msg: r.msg.slice(0, 140) };
  };

  // Registers every READY slug, 20s apart. A GATE (Luma asks for extra verification)
  // is either that one event's own challenge or the account's rolling budget for the
  // night; the loop waits 5 minutes and retries the same slug once, and if it gates
  // again it stops for the night. Do not engineer around it — pacing is the fix.
  window.__regRun = async function () {
    if (window.__running) return 'already';
    window.__running = true;
    const q = ls(K('q')); const cls = ls(K('cls')); const res = ls(K('res'));
    const todo = q.filter((s) => cls[s] && cls[s].cls === 'READY' && !res[s]);
    let i = 0;
    for (const slug of todo) {
      i++; hb({ state: 'REG', slug, i, n: todo.length });
      let o = await window.__doOne(slug);
      if (o.st === 'GATE') { hb({ state: 'COOLDOWN', slug }); await sleep(300000); o = await window.__doOne(slug); }
      if (o.st === 'GATE') { res[slug] = o; ls(K('res'), res); hb({ state: 'GATED-STOP', slug }); break; }
      res[slug] = o; ls(K('res'), res); await sleep(20000);
    }
    hb({ state: 'REG-DONE', n: todo.length }); window.__running = false; return 'done';
  };

  // ---------- helpers for the operator ----------
  window.__status = function () {
    const q = ls(K('q')); const cls = ls(K('cls')); const res = ls(K('res'));
    const by = {}; for (const s of (Array.isArray(q) ? q : [])) { const c = (cls[s] || {}).cls || 'PENDING'; by[c] = (by[c] || 0) + 1; }
    const rby = {}; for (const s in res) { rby[res[s].st] = (rby[res[s].st] || 0) + 1; }
    let used = 0; for (const k in localStorage) if (Object.prototype.hasOwnProperty.call(localStorage, k)) used += (localStorage[k] || '').length;
    return { run: window.__RUN, hb: JSON.parse(localStorage.getItem(K('hb')) || 'null'), queued: (q || []).length, classified: by, results: rby, localStorageKB: Math.round(used * 2 / 1024) };
  };

  // Renders READY plans (and NEEDS-HUMAN questions) as plain text at the top of the page
  // so get_page_text can read them for the dry-run review.
  window.__review = function () {
    const q = ls(K('q')); const cls = ls(K('cls'));
    const lines = ['=== luma-autopilot dry run ' + window.__RUN + ' ==='];
    for (const s of q) {
      const c = cls[s]; if (!c) continue;
      if (c.cls === 'READY') {
        lines.push('', 'READY ' + s + (c.forWaitlist ? ' (waitlist)' : '') + (c.req ? ' (approval required)' : '') + ' — ' + c.name);
        for (const a of c.answers) lines.push('   ' + (a.label || a.question_type) + ' → ' + JSON.stringify(a.value));
      } else if (c.cls === 'NEEDS-HUMAN') {
        lines.push('', 'NEEDS-HUMAN ' + s + ' — ' + c.name);
        for (const n of c.needs) lines.push('   Q: ' + n);
      }
    }
    let el = document.getElementById('__autopilot_review');
    if (!el) { el = document.createElement('pre'); el.id = '__autopilot_review'; el.style.cssText = 'position:relative;z-index:99999;background:#fff;color:#000;padding:16px;white-space:pre-wrap;font:13px/1.4 monospace'; document.body.prepend(el); }
    el.textContent = lines.join('\n');
    return lines.length + ' lines';
  };

  // Fix one answer in a READY plan before registering: __fix(slug, /label regex/i, value).
  // For select questions pass an array of option strings.
  window.__fix = function (slug, labelRe, value) {
    const cls = ls(K('cls')); const c = cls[slug];
    if (!c || c.cls !== 'READY') return 'not READY';
    const a = c.answers.find((x) => labelRe.test(x.label || ''));
    if (!a) return 'no such answer';
    a.value = value; ls(K('cls'), cls); return 'ok: ' + a.label + ' → ' + JSON.stringify(value);
  };

  // Drop a slug from tonight's run (marks it SKIP-MANUAL so __regRun ignores it).
  window.__skip = function (slug, why) {
    const cls = ls(K('cls')); cls[slug] = { cls: 'SKIP-MANUAL', why: why || '' }; ls(K('cls'), cls); return 'skipped ' + slug;
  };

  // Wipe a run's keys (use when starting over, or to free localStorage — it is capped at ~5MB).
  window.__reset = function (run) {
    const r = run || window.__RUN;
    for (const n of ['q', 'cls', 'res', 'hb']) localStorage.removeItem('__' + n + r);
    return 'reset ' + r;
  };

  return 'luma-autopilot loaded for run ' + window.__RUN;
})();
