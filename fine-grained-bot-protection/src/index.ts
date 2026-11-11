import { Permit } from 'permitio';
import { createApp } from '#src/app';
import { chooseClassifier } from '#src/choose-classifier';
import { type AppConfig, loadAppConfig } from '#src/config';

let config: AppConfig;
try {
  config = loadAppConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const classifier = chooseClassifier(config.arcjetKey);
const permit = new Permit({ token: config.apiKey, pdp: config.pdpUrl });

createApp({ classifier, permit }).listen(config.port, '0.0.0.0', () => {
  console.log(`Bot classifier: ${classifier.description}`);
  console.log(`Listening on port ${config.port}; asking the PDP at ${config.pdpUrl}`);
});
