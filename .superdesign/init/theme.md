# Compact design tokens
Colors: ivory #f3f4ee, ink #20241c, forest #1e261f, lime #c9f45b, muted #747b6b, line #dde1d5, green #376447. Font: Inter/system sans. Rounded corners 5-7px. Type: hero 40-59px, headings 29-38px, body 13-17px, metadata 10-12px. Spacing: 8/12/16/24/32/48/96px. Breakpoints 540/760/1000px.

# Raw application stylesheet
```css
:root {
  --bg: #f3f4ee;
  --panel: #fff;
  --ink: #20241c;
  --muted: #747b6b;
  --line: #dde1d5;
  --lime: #c9f45b;
  --green: #376447;
  --dark: #1e261f;
  --red: #b63a30;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--bg);
  font-synthesis: none;
}
* {
  box-sizing: border-box;
}
[hidden] {
  display: none !important;
}
.auth-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
  max-width: 1000px;
}
.auth-card,
.demo-card {
  padding: 32px;
}
.auth-card h2,
.demo-card h2 {
  margin-top: 20px;
}
.auth-actions {
  display: grid;
  gap: 12px;
  margin: 24px 0;
}
.demo-card {
  background: #edf2e5;
}
.agent-profile {
  margin-top: 24px;
  max-width: 850px;
}
#auth-error {
  color: var(--red);
}
.identity {
  flex-wrap: wrap;
}
@media (max-width: 760px) {
  .auth-layout {
    grid-template-columns: 1fr;
  }
}
body {
  margin: 0;
}
button,
input,
select,
textarea {
  font: inherit;
}
button,
a {
  touch-action: manipulation;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: wait;
}
a {
  color: inherit;
}
.task-link {
  text-decoration: none;
}
.task-link:hover {
  text-decoration: underline;
}
aside {
  position: fixed;
  inset: 0 auto 0 0;
  width: 230px;
  background: var(--dark);
  color: #e7ebdf;
  padding: 32px 23px;
  display: flex;
  flex-direction: column;
}
.brand {
  text-decoration: none;
  font-size: 27px;
  font-weight: 800;
  letter-spacing: -1.3px;
  display: flex;
  justify-content: space-between;
}
.brand span {
  color: var(--lime);
}
.workspace-label {
  margin: 54px 12px 16px;
  font-size: 10px;
  letter-spacing: 2px;
  color: #899882;
}
nav {
  display: grid;
  gap: 8px;
}
nav a {
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #aebba7;
  text-align: left;
  padding: 15px 13px;
  display: flex;
  gap: 15px;
  text-decoration: none;
}
nav a.active {
  background: #354030;
  color: var(--lime);
}
nav a:hover {
  background: #2b342b;
}
.sidebar-bottom {
  margin-top: auto;
  font-size: 12px;
  color: #bac4b3;
}
.sidebar-bottom p {
  font-size: 11px;
  line-height: 1.8;
  color: #8e9b85;
  margin: 22px 0;
}
.live-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  background: var(--lime);
  border-radius: 100%;
  margin-right: 5px;
}
.network-tag {
  font-size: 9px;
  letter-spacing: 1.5px;
  border: 1px solid #46523f;
  padding: 7px;
}
.shell {
  margin-left: 230px;
}
header {
  height: 82px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 38px;
  gap: 20px;
  font-size: 12px;
  background: #f9faf6;
}
.small-label {
  color: var(--muted);
  margin-right: 8px;
}
.identity {
  display: flex;
  gap: 10px;
  align-items: center;
}
.identity label {
  font-size: 10px;
  color: var(--muted);
}
select,
input,
textarea {
  padding: 11px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: white;
  color: var(--ink);
  min-width: 0;
}
#identity-key {
  font: 10px monospace;
  color: var(--muted);
}
main {
  max-width: 1580px;
  margin: auto;
  padding: 40px 38px 60px;
}
.page-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 28px;
}
.eyebrow {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.8px;
  color: var(--green);
  margin: 0 0 12px;
}
h1 {
  font-size: clamp(27px, 3vw, 42px);
  letter-spacing: -1.6px;
  margin: 0 0 12px;
  font-weight: 650;
}
#subtitle {
  font-size: 13px;
  color: var(--muted);
  margin: 0;
  line-height: 1.6;
}
.button {
  text-decoration: none;
  padding: 11px 16px;
  border: 1px solid var(--line);
  border-radius: 5px;
  font-size: 12px;
  font-weight: 600;
  background: white;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
}
.button:hover {
  border-color: #8d9982;
}
.primary {
  background: var(--lime);
  border-color: var(--lime);
  color: #29301e;
}
.dark {
  background: var(--dark);
  color: white;
  border-color: var(--dark);
}
.quiet {
  background: transparent;
}
.danger {
  color: var(--red);
}
.notice {
  font-size: 11px;
  line-height: 1.6;
  background: #e9eedf;
  border: 1px solid #d8e0cd;
  padding: 12px 15px;
  margin-bottom: 24px;
  border-radius: 5px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border: 1px solid var(--line);
  border-radius: 8px;
  background: white;
  margin-bottom: 30px;
}
.stat {
  padding: 21px 24px;
  border-right: 1px solid var(--line);
}
.stat:last-child {
  border: 0;
}
.stat-label {
  font-size: 10px;
  color: var(--muted);
  letter-spacing: 1px;
  text-transform: uppercase;
}
.stat-value {
  font-size: 29px;
  margin: 10px 0 6px;
  letter-spacing: -1px;
}
.stat-note {
  font-size: 10px;
  color: var(--muted);
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 27px 0 16px;
  gap: 12px;
}
h2 {
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.4px;
  margin: 0;
}
.section-head p {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 12px;
}
.badge {
  font-size: 9px;
  letter-spacing: 0.5px;
  border-radius: 4px;
  padding: 5px 7px;
  text-transform: uppercase;
  background: #eef1e8;
  color: #5e6d50;
  white-space: nowrap;
}
.badge.working {
  background: #e8ebff;
  color: #565eac;
}
.badge.review {
  background: #fff0d6;
  color: #8a6329;
}
.badge.accepted {
  background: #e4f5d9;
  color: #386333;
}
.badge.changes_requested {
  background: #fae4df;
  color: #975241;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.card {
  background: white;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 22px;
  min-width: 0;
}
.card:hover {
  border-color: #aebc9f;
}
.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.card h3 {
  font-size: 16px;
  line-height: 1.45;
  letter-spacing: -0.3px;
  margin: 20px 0 9px;
}
.card p {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.7;
  margin: 0 0 16px;
}
.card .meta {
  font-size: 10px;
  color: var(--muted);
}
.card-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid var(--line);
  padding-top: 15px;
  margin-top: 20px;
}
.amount {
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.6px;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tag {
  font-size: 9px;
  border: 1px solid var(--line);
  padding: 4px 7px;
  border-radius: 4px;
  color: var(--muted);
}
.avatar {
  background: var(--lime);
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-weight: 650;
  color: #3d5024;
}
.agent-row {
  display: flex;
  gap: 12px;
  align-items: center;
}
.agent-row strong {
  font-size: 13px;
}
.agent-row small {
  display: block;
  color: var(--muted);
  font-size: 10px;
  margin-top: 5px;
}
.empty {
  padding: 65px 25px;
  text-align: center;
  border: 1px dashed #bcc6af;
  border-radius: 9px;
}
.empty p {
  color: var(--muted);
  line-height: 1.7;
  font-size: 13px;
  max-width: 480px;
  margin: 14px auto 24px;
}
.split {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(280px, 1fr);
  gap: 20px;
}
.panel {
  border: 1px solid var(--line);
  background: white;
  border-radius: 8px;
  padding: 24px;
}
.panel h3 {
  font-size: 14px;
  margin: 0 0 16px;
}
.row {
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.row:last-child {
  border-bottom: 0;
}
.row p {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
  margin: 7px 0;
}
.row small {
  font-size: 10px;
  color: var(--muted);
}
.row strong {
  font-size: 12px;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 20px 0;
}
.hash {
  font: 10px ui-monospace, monospace;
  word-break: break-all;
  color: #737d68;
  line-height: 1.6;
}
.detail-title {
  font-size: 29px;
  margin: 15px 0 10px;
}
.detail-brief {
  font-size: 13px;
  line-height: 1.8;
  color: var(--muted);
  white-space: pre-wrap;
}
.progress-track {
  display: flex;
  gap: 3px;
  margin: 25px 0;
}
.progress-track span {
  flex: 1;
  background: #e8eadf;
  padding: 9px 5px;
  text-align: center;
  font-size: 9px;
}
.progress-track span.current {
  background: var(--lime);
}
.event {
  display: grid;
  grid-template-columns: 70px 1fr auto;
  gap: 15px;
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
}
.event .seq {
  font: 11px monospace;
  color: var(--muted);
}
.event strong {
  font-size: 12px;
}
.event p {
  font-size: 11px;
  color: var(--muted);
  margin: 6px 0;
  line-height: 1.6;
}
.link-button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--green);
  font: 10px monospace;
  text-decoration: underline;
}
.project-summary {
  background: var(--dark);
  color: white;
  padding: 25px 28px;
  border-radius: 8px;
  margin-bottom: 24px;
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: center;
}
.project-summary p {
  color: #acbaa1;
  font-size: 12px;
  line-height: 1.6;
  margin: 9px 0;
}
.project-summary .badge {
  background: #3a482f;
  color: var(--lime);
}
.project-summary h2 {
  font-size: 24px;
}
.budget {
  font-size: 24px;
  color: var(--lime);
  white-space: nowrap;
}
dialog {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 28px;
  width: min(540px, calc(100% - 30px));
  max-height: 90vh;
  color: var(--ink);
}
dialog::backdrop {
  background: #18201688;
  backdrop-filter: blur(3px);
}
.dialog-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 23px;
}
.icon-button {
  border: 0;
  background: transparent;
  font-size: 23px;
  color: var(--muted);
}
#dialog-fields {
  display: grid;
  gap: 15px;
}
#dialog-fields label {
  font-size: 11px;
  font-weight: 600;
  display: grid;
  gap: 7px;
}
#dialog-fields textarea {
  min-height: 100px;
  resize: vertical;
  font-weight: 400;
}
#dialog-fields input {
  width: 100%;
  font-weight: 400;
}
#dialog-error {
  color: var(--red);
  font-size: 12px;
  line-height: 1.5;
}
#dialog-submit {
  margin-top: 10px;
  width: 100%;
}
#toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  max-width: 460px;
  padding: 16px 22px;
  background: var(--dark);
  color: white;
  border-radius: 8px;
  box-shadow: 0 4px 25px #0002;
  font-size: 12px;
  line-height: 1.6;
  display: none;
  z-index: 20;
}
#toast.visible {
  display: block;
}
footer {
  padding: 22px 38px;
  border-top: 1px solid var(--line);
  font-size: 9px;
  color: var(--muted);
  letter-spacing: 0.5px;
  display: flex;
  justify-content: space-between;
}
pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
  line-height: 1.7;
  background: #f2f4ed;
  padding: 15px;
  max-height: 330px;
  overflow: auto;
}
#dialog-fields select {
  width: 100%;
}
.muted {
  color: var(--muted);
}
.tiny {
  font-size: 10px;
}
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.stat small {
  font-size: 12px;
}
button:focus-visible,
a:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 2px solid #677d35;
  outline-offset: 3px;
}
@media (max-width: 1150px) {
  aside {
    width: 195px;
    padding: 30px 17px;
  }
  .shell {
    margin-left: 195px;
  }
  main {
    padding: 30px 25px;
  }
  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .identity label,
  #identity-key {
    display: none;
  }
  header {
    padding: 0 25px;
  }
  .split {
    grid-template-columns: 1fr;
  }
  .stat {
    padding: 18px;
  }
}
@media (max-width: 740px) {
  aside {
    position: static;
    width: auto;
    padding: 17px 20px;
    display: block;
  }
  .brand {
    font-size: 23px;
  }
  .brand span {
    display: none;
  }
  .workspace-label,
  .sidebar-bottom {
    display: none;
  }
  nav {
    display: flex;
    gap: 5px;
    margin-top: 17px;
    overflow: auto;
  }
  nav a {
    font-size: 11px;
    padding: 10px;
    gap: 6px;
    white-space: nowrap;
  }
  .shell {
    margin: 0;
  }
  header {
    height: auto;
    min-height: 70px;
    padding: 14px 20px;
    flex-wrap: wrap;
    gap: 10px;
  }
  .identity {
    width: 100%;
  }
  .identity select {
    flex: 1;
  }
  main {
    padding: 27px 20px;
  }
  h1 {
    font-size: 29px;
  }
  .page-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
  .stat:nth-child(2) {
    border-right: 0;
  }
  .stat:nth-child(-n + 2) {
    border-bottom: 1px solid var(--line);
  }
  .grid {
    grid-template-columns: 1fr;
  }
  .project-summary {
    align-items: flex-start;
    flex-direction: column;
  }
  .section-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .event {
    grid-template-columns: 45px 1fr;
  }
  .event > .badge {
    display: none;
  }
  footer {
    padding: 20px;
    font-size: 9px;
  }
  footer span {
    display: none;
  }
  .card {
    padding: 20px;
  }
  .notice {
    font-size: 10px;
  }
}

.graph-panel {
  margin-top: 24px;
}
.graph-scroll {
  overflow-x: auto;
  margin-top: 20px;
}
.graph-scroll svg {
  display: block;
  max-width: none;
}
.graph-scroll g {
  cursor: pointer;
}
.graph-scroll g:hover rect {
  stroke: #617844;
  stroke-width: 2;
}
.graph-scroll g:focus {
  outline: none;
}
.graph-scroll g:focus rect {
  stroke: #435f2d;
  stroke-width: 2;
}

/* Account entry is separate from the workspace navigation. */
.auth-page aside,.auth-page .shell>header,.auth-page .page-heading,.auth-page #stats,.auth-page .shell>footer,
.auth-pending aside,.auth-pending .shell>header,.auth-pending .page-heading,.auth-pending #stats,.auth-pending .shell>footer{display:none!important}
.auth-page .shell,.auth-pending .shell{margin-left:0;min-height:100vh}
.auth-page main{max-width:none;padding:38px 24px 55px}
.auth-shell{width:100%;max-width:480px;margin:0 auto}
.auth-brand{display:flex;align-items:center;justify-content:center;gap:25px;text-decoration:none;font-size:29px;font-weight:800;letter-spacing:-1.4px;margin:12px 0 39px}
.auth-brand span{font-weight:500;color:#608b29}
.auth-progress{display:flex;justify-content:space-between;gap:15px;margin:0 10px 22px;font-size:10px;letter-spacing:.6px;color:#7b8472}
.auth-progress .current{color:#385822;font-weight:700}
.auth-card{padding:33px 32px;border:1px solid var(--line)}
.auth-card h1{font-size:29px;line-height:1.2;letter-spacing:-1px;margin:0 0 17px}
.auth-intro{font-size:13px;line-height:1.8;color:#616b55;margin:0 0 26px}
.auth-card p{line-height:1.75}
.auth-card fieldset{padding:0;border:0;margin:0;min-width:0}
.auth-card label{display:block;font-size:12px;font-weight:600;margin:20px 0 9px}
.auth-card input{width:100%;border:1px solid #cdd4c3;border-radius:5px;padding:13px 12px;background:#fff;font-size:14px;min-width:0;color:var(--ink)}
.auth-card input:focus{outline:2px solid #8ea663;outline-offset:1px}
.password-field{position:relative}
.password-field input{padding-right:65px}
.password-field button{position:absolute;right:4px;top:4px;bottom:4px;border:0;background:transparent;font-size:11px;padding:0 12px;color:#566b40}
.auth-card .field-hint{font-size:10px;color:#747b6b;line-height:1.7;margin:9px 0 0}
.auth-card #auth-form .primary{width:100%;display:flex;justify-content:space-between;margin-top:20px;padding:14px 18px;background:var(--dark);color:white}
.auth-card .auth-text-link{font-size:12px;color:#456830}
#auth-form>.auth-text-link,#auth-form fieldset>.auth-text-link{display:block;margin-top:17px;text-align:right}
.auth-card #auth-error{font-size:12px;line-height:1.6;min-height:0;overflow-wrap:anywhere}
.auth-bottom{font-size:12px;border-top:1px solid var(--line);margin-top:27px;padding-top:22px;text-align:center}
.auth-footer{text-align:center;font-size:10px;line-height:1.7;color:#707967;margin-top:25px}
.local-mail{padding:16px;background:#f0f5e8;border:1px solid #dae4cc;border-radius:5px;margin:17px 0}
.local-mail p{font-size:12px;overflow-wrap:anywhere}.local-mail h3{font-size:15px}
.local-mail .button{font-size:12px}.linked-address{padding:15px;background:#f4f6ee;border-radius:5px}
.auth-card .auth-actions .button{justify-content:center}
@media(max-width:540px){.auth-page main{padding:20px 16px 35px}.auth-card{padding:27px 23px}.auth-card h1{font-size:27px}.auth-brand{margin:12px 0 30px}.auth-progress{font-size:9px}.auth-card input{font-size:16px}}

```
# Landing stylesheet
```css
:root{--bg:#f3f4ee;--ink:#20241c;--muted:#606856;--line:#d9dfce;--lime:#c9f45b;--dark:#1e261f;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg);font-synthesis:none}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:30px}body{margin:0}a{color:inherit;text-decoration:none}a:focus-visible{outline:3px solid #698c22;outline-offset:5px}button,a{touch-action:manipulation}.skip{position:absolute;top:-60px;background:white;padding:16px;z-index:5}.skip:focus{top:10px}.site-header,.hero,.principles,.section,.site-footer{max-width:1320px;margin:auto;padding-left:48px;padding-right:48px}.site-header{height:105px;display:flex;align-items:center;justify-content:space-between;gap:32px;border-bottom:1px solid var(--line)}.brand{font-size:27px;font-weight:800;letter-spacing:-1.3px;display:flex;align-items:center;gap:28px}.brand span{font-weight:500;font-size:31px}.site-header nav,.header-actions{display:flex;align-items:center;gap:32px;font-size:14px;font-weight:500}.site-header nav a:hover,.header-actions>a:first-child:hover{text-decoration:underline}.button{display:inline-flex;justify-content:space-between;align-items:center;gap:32px;border-radius:5px;padding:17px 23px;font-size:14px;font-weight:650;transition:transform .15s,background .15s}.button:hover{transform:translateY(-2px)}.dark{background:var(--dark);color:white}.dark:hover{background:#37472d}.lime{background:var(--lime);color:var(--dark)}.hero{padding-top:88px;padding-bottom:90px;display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:48px}.eyebrow{font-size:11px;font-weight:650;letter-spacing:1.7px;line-height:1.6;margin:0 0 25px}.dot{display:inline-block;background:#638c40;width:7px;height:7px;border-radius:50%;margin-right:7px}h1{font-size:clamp(40px,4.1vw,59px);letter-spacing:-2.9px;font-weight:650;line-height:1.1;margin:0 0 29px}h1 em{font-style:normal;color:#638042}.lede{font-size:17px;line-height:1.8;max-width:470px;color:var(--muted);margin:0}.hero-actions{display:flex;align-items:center;gap:27px;margin-top:32px}.text-link{font-size:14px;font-weight:600;display:flex;gap:13px}.hero-note{font-size:11px;color:var(--muted);margin:22px 0 0}.mesh-visual{border:1px solid #d8dfcc;border-radius:10px;background:#e8eddf;padding:25px 25px 19px;box-shadow:0 22px 50px -38px #293d0d}.visual-top{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:25px}.small-label{font-size:9px;letter-spacing:1.1px;font-weight:650}.example{font-size:10px;color:#626b57}.coordinator{display:flex;align-items:center;gap:14px;padding:19px 16px;background:var(--dark);border-radius:6px;color:#eff2e7}.node-icon{height:36px;width:36px;border:1px solid #667257;border-radius:5px;display:grid;place-items:center;color:var(--lime);font-size:23px}.coordinator .small-label{color:#b7c3ab;font-size:8px}.coordinator h2{font-size:14px;letter-spacing:-.3px;margin:5px 0 0}.node-status{color:var(--lime);font-size:10px;margin-left:auto}.branch{height:36px;width:70%;margin:auto;display:flex;justify-content:space-between;position:relative}.branch:before{content:"";position:absolute;left:0;right:0;top:17px;border-top:1px solid #a8b799}.branch span{border-left:1px solid #a8b799;height:19px;margin-top:17px}.branch span:nth-child(2){height:36px;margin-top:0}.agent-nodes{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.agent-nodes>div{background:#fafcf7;border:1px solid #d5ddc9;border-radius:5px;padding:15px 9px;display:flex;flex-direction:column;align-items:center;text-align:center}.agent-symbol{font-size:24px;margin-bottom:8px;color:#4e6539}.agent-nodes strong{font-size:11px}.agent-nodes small{font-size:10px;color:var(--muted);margin:6px 0 13px}.tag{font-size:8px;color:#4e6637;background:#e5eed9;padding:5px 7px;border-radius:3px}.context-line{display:flex;gap:14px;align-items:center;margin:24px 2px}.context-line>span{font-size:31px;color:#657d4a}.context-line strong{font-size:11px;display:block;margin-bottom:5px}.context-line small{font-size:9px;color:var(--muted)}.settlement{background:var(--lime);border-radius:5px;display:flex;align-items:center;justify-content:space-between;padding:16px 12px;gap:8px;font-size:10px}.settlement strong{font-size:11px}.settlement strong span{margin-left:8px}.principles{display:flex;justify-content:space-between;gap:20px;padding-top:25px;padding-bottom:25px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:11px;color:#626c56;font-weight:550}.section{padding-top:94px;padding-bottom:94px}.section-heading{position:relative}.section-heading h2,.network h2,.closing h2{font-size:38px;letter-spacing:-1.3px;font-weight:550;line-height:1.2;margin:0}.section-heading>p:last-child{position:absolute;right:0;bottom:0;max-width:330px;line-height:1.8;font-size:14px;color:var(--muted);margin:0}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:38px;margin-top:60px}.steps article{border-top:1px solid #bcc7af;padding-top:24px}.step{font-size:10px;letter-spacing:1.2px;color:#62774d}.steps h3{font-size:22px;letter-spacing:-.6px;line-height:1.35;font-weight:550;margin:24px 0 17px}.steps p{font-size:13px;line-height:1.85;color:var(--muted);max-width:320px;margin:0}.network{background:var(--dark);color:#f0f4e8;display:grid;grid-template-columns:1fr 1fr;gap:95px}.network .eyebrow{color:var(--lime)}.network-copy>p:not(.eyebrow){font-size:14px;line-height:1.9;color:#b7c2b1;max-width:395px;margin:25px 0 29px}.capabilities article{display:flex;gap:24px;padding:22px 0;border-bottom:1px solid #424e3d}.capabilities article:first-child{padding-top:0}.capabilities article>span{font-size:11px;color:var(--lime);padding-top:4px}.capabilities h3{margin:0 0 10px;font-size:17px;font-weight:550;letter-spacing:-.3px}.capabilities p{margin:0;color:#b7c2b1;font-size:12px;line-height:1.85}.closing{text-align:center;padding-top:100px;padding-bottom:96px}.closing .eyebrow{color:#6d7e5a}.closing h2{font-size:45px}.closing .button{margin-top:34px;min-width:237px}.closing>p:last-child{font-size:12px;color:var(--muted);margin-top:20px}.site-footer{display:flex;align-items:center;justify-content:space-between;gap:30px;border-top:1px solid var(--line);padding-top:34px;padding-bottom:36px}.site-footer p{font-size:10px;line-height:1.8;color:var(--muted)}.site-footer>a:last-child{font-size:12px;font-weight:600}@media(min-width:1440px){.site-header,.site-footer{max-width:1420px;padding-left:98px;padding-right:98px}}@media(max-width:1000px){.site-header,.hero,.principles,.section,.site-footer{padding-left:28px;padding-right:28px}.hero{gap:28px}.mesh-visual{padding:17px}.site-header nav{gap:20px}.network{gap:50px}.section-heading>p:last-child{max-width:260px}h1{font-size:43px;letter-spacing:-2px}.hero-actions{gap:16px}.button{gap:18px}.lede{font-size:15px}}@media(max-width:760px){.site-header{height:84px;gap:15px}.site-header nav{display:none}.brand{font-size:24px;gap:15px}.header-actions{gap:17px;font-size:12px}.header-actions .button{padding:12px 13px;font-size:12px;gap:15px}.hero{grid-template-columns:1fr;padding-top:55px;padding-bottom:45px;gap:42px}h1{font-size:clamp(37px,7.8vw,56px);letter-spacing:-1.9px}.hero .eyebrow{font-size:9px;letter-spacing:1.1px}.lede{max-width:520px;font-size:16px}.hero-actions{gap:24px}.mesh-visual{max-width:520px;width:100%;padding:21px}.principles{display:grid;grid-template-columns:1fr 1fr;font-size:10px;gap:16px}.section{padding-top:59px;padding-bottom:59px}.section-heading h2,.network h2{font-size:31px}.section-heading>p:last-child{position:static;margin-top:23px;max-width:450px}.steps{grid-template-columns:1fr;margin-top:38px;gap:33px}.steps h3 br{display:none}.steps h3{font-size:22px;margin:16px 0 11px}.steps p{max-width:none}.network{grid-template-columns:1fr;gap:40px}.network-copy>p:not(.eyebrow){max-width:450px}.closing h2{font-size:34px}.closing .eyebrow{font-size:9px}.site-footer{align-items:flex-start;flex-wrap:wrap;gap:24px}.site-footer p{order:3;margin:0;width:100%}.site-footer>a:last-child{padding-top:8px}.settlement{font-size:9px}.settlement strong{font-size:10px}.agent-nodes{gap:7px}.agent-nodes>div{padding:13px 6px}.agent-nodes strong{font-size:10px}.visual-top{gap:6px}.small-label{font-size:8px}.example{font-size:8px}.hero-actions .button{font-size:13px}.text-link{font-size:12px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.button{transition:none}}

```
