/** Declarative, synthetic-only plan. This module has no network or write capability. */
export const CLOUD_PROJECT_ID = '13eaac67-a2c3-4aa1-aa9e-590a083e5fef';
export const CLOUD_CLIENT_ID = '50db76bd-d099-4305-8ec3-7439ffc38ca1';
export const CLOUD_MEMBERSHIP_ID = '6e565de2-837d-4618-9578-f6428fbb0be1';
export const CLOUD_API_BASE = 'https://api.medplum.com/';
export const DEMO_NAMESPACE = 'urn:corvo:clinic:synthetic-demo:v1';
export const INVENTORY_TYPES = Object.freeze([
  'Patient', 'Practitioner', 'PractitionerRole', 'CareTeam', 'Organization', 'Location',
  'Appointment', 'Encounter', 'Questionnaire', 'QuestionnaireResponse', 'DocumentReference',
  'Binary', 'Task', 'Provenance', 'Observation', 'Condition', 'MedicationStatement',
  'MedicationRequest', 'AllergyIntolerance', 'Consent', 'Communication',
  'AccessPolicy', 'ProjectMembership', 'ClientApplication',
]);
export const SCENARIOS = Object.freeze(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill']);
export const RUNTIME_TYPES = Object.freeze(['Patient', 'CareTeam', 'QuestionnaireResponse', 'DocumentReference', 'Binary', 'Task', 'Provenance']);

export function clinicalRules(patientReference, questionnaireReference) {
  return [
    ...(questionnaireReference ? [{ resourceType: 'Questionnaire', criteria: `Questionnaire?_id=${questionnaireReference.split('/')[1]}`, readonly: true }] : []),
    { resourceType: 'Practitioner', criteria: 'Practitioner?_id=%profile.id', readonly: true },
    { resourceType: 'Patient', criteria: `Patient?_id=${patientReference.split('/')[1]}`, readonly: true },
    ...['CareTeam', 'QuestionnaireResponse', 'DocumentReference', 'Task', 'Provenance'].map(resourceType => ({ resourceType, criteria: `${resourceType}?_compartment=${patientReference}`, readonly: true })),
    // Binary authorization must inherit its DocumentReference security context;
    // positive and cross-patient negative tests are mandatory before deployment.
    { resourceType: 'Binary', readonly: true },
  ];
}

export function seedPlan() {
  const primary = 'Patient/{{patient-primary-id}}';
  const unrelated = 'Patient/{{patient-unrelated-id}}';
  const policy = (key, name, resource) => ({ key, resource: { resourceType: 'AccessPolicy', name, resource } });
  const patient = (key, given, family) => ({ key, resource: { resourceType: 'Patient', identifier: [{ system: DEMO_NAMESPACE, value: key }], active: true, name: [{ given: [given], family: `${family} (synthetic)` }] } });
  return {
    schema: 1, kind: 'reviewable-seed-plan-not-executable-bundle', projectId: CLOUD_PROJECT_ID,
    apiBase: CLOUD_API_BASE, projectName: 'Corvo Clinic', namespace: DEMO_NAMESPACE,
    deliveryContract: 'conditional-resumable-v1', projectFeaturesRequired: [],
    existingClientCandidate: { id: CLOUD_CLIENT_ID, disposition: 'reuse-only-after-project-membership-and-effective-policy-verification' },
    setupPrivilege: {
      project: CLOUD_PROJECT_ID,
      membershipId: CLOUD_MEMBERSHIP_ID,
      temporaryAdmin: true,
      purpose: 'explicit-policies-and-synthetic-membership-provisioning',
      finalAdmin: false,
      finalAccessPolicy: 'runtime',
      finalClientAction: 'demote-same-client-to-runtime-policy-revoke-bootstrap-token-before-qualifying',
      accountOrServerAdmin: false,
    },
    projectChange: { operation: 'no-feature-change-required-for-selected-conditional-contract' },
    authority: { syntheticOnly: true, accountWideOperations: false, deleteOperations: false, sendEmail: false },
    patients: [patient('primary', 'Alex', 'Rivera'), patient('unrelated', 'Jordan', 'Chen')],
    careTeams: ['medical', 'nutrition', 'administrative'].map(responsibility => ({ key: responsibility, resource: { resourceType: 'CareTeam', identifier: [{ system: DEMO_NAMESPACE, value: `care-team-${responsibility}` }], status: 'active', name: `Corvo ${responsibility} care team`, subject: { reference: primary } } })),
    policies: [
      policy('clinical-assigned', 'Corvo demo assigned clinical read only', clinicalRules(primary)),
      policy('clinical-unassigned', 'Corvo demo unrelated patient read only', clinicalRules(unrelated)),
      policy('administrative', 'Corvo demo administrative logistics only', [
        { resourceType: 'Practitioner', criteria: 'Practitioner?_id=%profile.id', readonly: true },
        { resourceType: 'Task', criteria: `Task?_compartment=${primary}&code=urn:corvo:clinical:work-kind|administrative`, readonly: true },
      ]),
      policy('runtime', 'Corvo demo runtime persistence only', RUNTIME_TYPES.map(resourceType => ({ resourceType, interaction: ['create', 'read', 'search', 'update', 'history', 'vread'] }))),
    ],
    staff: [
      { key: 'medical', name: 'Dr. Morgan Lee', role: 'physician', policy: 'clinical-assigned', patient: 'primary', ownerOf: ['medical'] },
      { key: 'dietitian', name: 'Sam Patel, RD', role: 'registered-dietitian', policy: 'clinical-assigned', patient: 'primary', ownerOf: ['nutrition'] },
      { key: 'administrative', name: 'Taylor Brooks', role: 'administrative', policy: 'administrative', patient: 'primary', ownerOf: ['administrative'] },
      { key: 'unassigned', name: 'Dr. Quinn Parker', role: 'physician', policy: 'clinical-unassigned', patient: 'unrelated', ownerOf: [] },
    ].map(staff => ({ ...staff, membershipAdmin: false, sendEmail: false, email: `${staff.key}.${CLOUD_PROJECT_ID.slice(0, 8)}@example.invalid`, password: '{{generate-private-random-password-at-execution}}' })),
    questionnaire: { canonical: 'https://corvo.example/Questionnaire/clinic', version: 'CC-0.2.phq4.native-4', identity: 'url-and-version', readback: 'exact-authored-definition-and-history-version', compiler: 'packages/clinic-content/src/native-questionnaire.ts', runtimeAccess: 'read-search-vread-history-only-for-exact-questionnaire-id', administrativeAccess: 'none' },
    runtime: { admin: false, policy: 'runtime', noAccessTo: ['AccessPolicy', 'ProjectMembership', 'ClientApplication'], secretDelivery: 'private-file-or-host-secret-store-only' },
    scenarios: SCENARIOS.map(id => ({ id, patient: 'primary', mentalHealth: 'phq4', identity: 'synthetic-demo-capability-not-real-patient-verification' })),
    sequence: [
      'Read-only auth/me and bounded inventory; verify exact named project and account plan.',
      'Separately enumerate and review any resources to remove. This plan performs no deletion.',
      'Select conditional-resumable-v1 delivery. No patient flow starts before native qualification succeeds.',
      'Create primary and unrelated synthetic patients with deterministic identifiers; preserve native IDs.',
      'Create care teams, resolve policy references, then create explicit access policies.',
      'Create or reconcile named staff memberships with sendEmail:false and admin:false; save secrets privately.',
      'Set care team participants from the intended responsibilities; clinical read policies cover full assigned intake.',
      'Finish setup, then demote the reused temporary bootstrap membership to admin:false with the runtime access policy, verify revoked admin access, and revoke the bootstrap OAuth session. Keep the existing client secret private.',
      'Write private clinic configuration from returned IDs; generate a separate cookie secret per deployment.',
      'Run conditional identity/concurrency, version history/CAS, recovery/action history and direct named-role authorization qualification; retain results and synthetic fixture IDs.',
      'Seal deployment attestation only after every required check and confirmation that temporary setup access is revoked.',
    ],
    reconcileRule: 'Persist intent before every write, retain returned native ID/version, and read back identity and content. A timeout is an unknown outcome; do not blindly retry or duplicate client/member creation.',
  };
}
