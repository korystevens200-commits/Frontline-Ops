import { html } from "../html.js";
import { bareLayout } from "./layout.js";

export function loginPage({ operators, error = null, next = "", selected = "" }) {
  const body = html`
<div class="login-wrap">
  <div class="login-mark grad-text">Frontline Ops</div>
  <p class="login-sub">Command center · authorised users only</p>

  ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ""}

  <form method="POST" action="/login" class="card">
    <input type="hidden" name="next" value="${next}">

    <div class="field">
      <label>Who's calling?</label>
      <div class="who-grid">
        ${operators.map((name, index) => html`
          <label class="who-opt">
            <input type="radio" name="operator" value="${name}" required
                   ${(selected ? selected === name : index === 0) ? "checked" : ""}>
            <span>${name}</span>
          </label>`)}
      </div>
    </div>

    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required
             autocomplete="current-password" autofocus>
    </div>

    <button class="btn btn-primary" type="submit">Sign in</button>
  </form>
</div>`;

  return bareLayout({ title: "Sign in", body });
}
