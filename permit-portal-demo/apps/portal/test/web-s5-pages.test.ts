// S5's Integrations pages as they render: which buttons Sam's card offers for each scope, how it names the organization the
// connector acts for, and the reason Pippin's production request starts with, so the presenter never types on camera.
// The components are rendered to HTML in Node, so no browser is needed.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MetaContext } from '../src/web/hooks';
import { ProductionRequestForm } from '../src/web/pages/s5/PippinIntegrations';
import { IntegrationCard } from '../src/web/pages/s5/SamIntegrations';
import { PRODUCTION_REASON, type Integration, type ScopeEntry } from '../src/web/pages/s5/scope';
import type { Meta } from '../src/web/types';

const META: Meta = {
  profile: 'test', permitAppUrl: 'https://app.permit.io', demoClock: { enabled: false, offsetMs: 0 }, grantDemoDurationMs: 120_000, shipments: [],
  personas: [
    { key: 'sam', name: 'Samwise Gamgee', company: 'Shire Freight', title: 'Organization admin' },
    { key: 'pippin', name: 'Peregrin Took', company: 'Shire Freight', title: 'Developer' },
  ],
};

const client = (ean: string): ScopeEntry => ({ role: 'integration_client', resource: `ean:${ean}` });
const reader = (ean: string): ScopeEntry => ({ role: 'integration_reader', resource: `ean:${ean}` });

const connector = (scope: ScopeEntry[]): Integration => ({
  key: 'shire-erp', name: 'Shire ERP connector', owner: 'pippin', customer: 'shire-freight', customer_name: 'Shire Freight', scope, requests: [], recent: [],
});

/** Sam's card for a connector with `scope`, as HTML. */
const card = (scope: ScopeEntry[]) =>
  renderToStaticMarkup(createElement(MetaContext.Provider, { value: META }, createElement(IntegrationCard, { integration: connector(scope), busy: false, onChange: () => {} })));

/** The buttons a card offers, by their words. */
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => (m[1] ?? '').replace(/<[^>]+>/g, ''));

describe("Sam's integration card", () => {
  it('offers each button only when it would change something', () => {
    // Production access: view-only would swap EAN-1001's client role, revoke would end both EANs.
    expect(buttons(card([client('EAN-SANDBOX'), client('EAN-1001')]))).toEqual(['Make view-only', 'Revoke']);
    // Already view-only on EAN-1001: making it view-only again changes nothing.
    expect(buttons(card([client('EAN-SANDBOX'), reader('EAN-1001')]))).toEqual(['Revoke']);
    // The sandbox alone is test scope: nothing to make view-only, but revoke still ends it.
    expect(buttons(card([client('EAN-SANDBOX')]))).toEqual(['Revoke']);
  });

  it('offers nothing once the connector has no access at all, and says why', () => {
    const html = card([]);
    expect(buttons(html)).toEqual([]);
    expect(html).toContain('No access. Permit denies every call the integration makes.');
  });

  it("names the organization the connector acts for by its name, not its tenant key", () => {
    const html = card([client('EAN-SANDBOX')]);
    expect(html).toContain('Acts for');
    expect(html).toContain('Shire Freight');
    expect(html).not.toContain('shire-freight');
  });
});

describe("Pippin's production request", () => {
  it('starts with the EAN and the reason filled in, so nothing is typed on camera', () => {
    const html = renderToStaticMarkup(createElement(ProductionRequestForm, { integration: connector([client('EAN-SANDBOX')]), onRequested: () => {} }));
    expect(PRODUCTION_REASON).toBe('Nightly order sync from Shire ERP into EAN-1001');
    expect(html).toContain(`value="${PRODUCTION_REASON}"`);
    expect(html).toContain('value="EAN-1001"');
  });
});
