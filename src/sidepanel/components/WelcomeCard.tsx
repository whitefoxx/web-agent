import { IconLogo } from '../Icons';

/**
 * Welcome card — first impression when the sidepanel opens with no messages.
 * Shows what Web Agent can do in a visually engaging way.
 */
export function WelcomeCard(): preact.JSX.Element {
  return (
    <div class="welcome">
      <div class="welcome-glow" />
      <div class="welcome-brand-row">
        <IconLogo size={30} class="welcome-brand-icon" />
        <h3>Web Agent</h3>
      </div>
      <p class="welcome-intro">
        Your browser AI copilot — you give the instruction, the model reasons,
        and the extension acts on the page (browse, search, click, screenshot) to hand you a finished answer.
      </p>
      <div class="welcome-cards">
        <div class="welcome-card">
          <span class="welcome-card-icon">🌐</span>
          <div>
            <strong>Summarize this page</strong>
            <p>Tap the 🌐 button below or type "Summarize the key points of this article"</p>
          </div>
        </div>
        <div class="welcome-card">
          <span class="welcome-card-icon">🔍</span>
          <div>
            <strong>Cross-site research</strong>
            <p>"Look up reviews of Roborock vacuums and compare a few platforms"</p>
          </div>
        </div>
        <div class="welcome-card">
          <span class="welcome-card-icon">⚡</span>
          <div>
            <strong>Explore a new site</strong>
            <p>No ready-made adapter? Use /explore and let it figure things out</p>
          </div>
        </div>
      </div>
    </div>
  );
}
