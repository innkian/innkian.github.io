/* Ticket type definitions: fields, sections, required fields and workflows.
   Edit this file to add fields or change the lists. */
(function () {
  const LIKELIHOOD = ["Rare", "Unlikely", "Possible", "Likely", "Almost Certain"];
  const SEVERITY = ["Slight", "Minor", "Moderate", "Major", "Catastrophic"];
  const COMPONENTS = ["Process Plant", "Inflow", "Outflow", "Rail", "Port", "Mine", "Infrastructure", "Power"];
  const DEPARTMENTS = ["PCS", "Maintenance", "Electrical", "Mechanical", "Production", "Projects", "Operations"];
  const HUMAN_CONTROLS = ["Not Required", "Routine Monitoring", "Continuous Monitoring", "Dedicated Observer", "Barricading / Isolation"];

  // Risk rank: likelihood (1–5) × severity (1–5). Generic 5×5 matrix; adjust bands to your site matrix.
  function riskRank(l, s) {
    const li = LIKELIHOOD.indexOf(l) + 1, si = SEVERITY.indexOf(s) + 1;
    if (!li || !si) return null;
    const score = li * si;
    const band = score <= 3 ? "Low" : score <= 8 ? "Medium" : score <= 14 ? "High" : "Critical";
    return { score, band };
  }

  const riskFields = (rankLabel) => [
    { k: "humanControls", label: "Human Controls", type: "select", opts: HUMAN_CONTROLS, req: true },
    { k: "risks", label: "Risks", type: "textarea", req: true, wide: true, help: "What could go wrong while this is in place?" },
    { k: "controls", label: "Controls", type: "textarea", req: true, wide: true },
    { k: "residualRisks", label: "Residual Risks", type: "textarea", wide: true, placeholder: "N/A" },
    { k: "likelihood", label: "Risk Likelihood", type: "select", opts: LIKELIHOOD, req: true },
    { k: "severity", label: "Risk Severity", type: "select", opts: SEVERITY, req: true },
    { k: "_risk", label: rankLabel, type: "risk" },
  ];

  const TYPES = {
    change: {
      label: "Change Request",
      short: "Change",
      sections: [
        { title: "Details", fields: [
          { k: "priority", label: "Priority", type: "select", opts: ["1 – Next 48 Hours", "2 – Next Week", "3 – Next Fortnight", "Low", "Medium", "High", "Critical"], req: true, def: "Medium" },
          { k: "component", label: "Component", type: "text", list: COMPONENTS, req: true },
          { k: "department", label: "Department", type: "text", list: DEPARTMENTS, req: true, def: "PCS" },
          { k: "equipment", label: "Equipment / Labels", type: "text", placeholder: "e.g. CVR061" },
          { k: "fixVersion", label: "Fix Version", type: "text", def: "Backlog" },
        ]},
        { title: "Register Tracking", fields: [
          { k: "site", label: "Site", type: "text", placeholder: "e.g. Pilgangoora" },
          { k: "registerStatus", label: "Register status", type: "text", placeholder: "e.g. CODE In Development" },
          { k: "dateSubmitted", label: "Date submitted", type: "date" },
          { k: "approver", label: "Approver", type: "person" },
          { k: "actionOwner", label: "Action owner", type: "person" },
          { k: "latestPosition", label: "Latest position", type: "textarea", wide: true },
          { k: "nextAction", label: "Next action", type: "textarea", wide: true },
          { k: "statusConflict", label: "Status conflict / register note", type: "text", wide: true },
        ]},
        { title: "Change Request", fields: [
          { k: "why", label: "Why is the change required?", type: "textarea", req: true, wide: true, rows: 5 },
        ]},
        { title: "Change Design", fields: [
          { k: "design", label: "What is going to change?", type: "textarea", req: true, wide: true, rows: 6 },
          { k: "fSetpoints", label: "Engineering setpoints?", type: "yesno", req: true },
          { k: "fTags", label: "Produced/consumed tags?", type: "yesno", req: true },
          { k: "fFunctionality", label: "Functionality?", type: "yesno", req: true },
          { k: "fAlarms", label: "Alarms?", type: "yesno", req: true },
          { k: "fIO", label: "I/O?", type: "yesno", req: true },
        ], note: "Does this change create new or modify existing…" },
        { title: "Impact", fields: [
          { k: "impact", label: "What do people need to do differently?", type: "textarea", req: true, wide: true },
        ]},
        { title: "Commissioning and Testing", fields: [
          { k: "testCriteria", label: "What are the test criteria?", type: "textarea", req: true, wide: true, rows: 4,
            placeholder: "Commissioning test plan: every test case and scenario that proves the change meets the functional requirements." },
          { k: "testRequirements", label: "What are the test requirements?", type: "textarea", req: true, wide: true,
            placeholder: "e.g. Exclusive control of the Reclaimer, 1 x Electrician, 1 x Field Operator, 4 hours." },
        ]},
        { title: "Schedule & Support", fields: [
          { k: "scheduleDate", label: "Forecast implementation date", type: "date" },
          { k: "scheduleNote", label: "Schedule notes", type: "text", placeholder: "Shutdown window, dependencies…" },
          { k: "support", label: "Support", type: "textarea", wide: true, placeholder: "Day/night shift contacts if not PCS Support, e.g. project work." },
          { k: "dmsLink", label: "DMS File Link", type: "url", wide: true, placeholder: "http://dms…" },
        ]},
        { title: "Risk", fields: riskFields("Calculated Rank") },
        { title: "People", fields: [
          { k: "assignee", label: "Assignee", type: "person" },
          { k: "reporter", label: "Reporter", type: "person", me: true },
          { k: "maintenanceApprover", label: "Maintenance Approver", type: "person", req: true },
          { k: "productionApprover", label: "Production Approver", type: "person", req: true },
          { k: "reviewers", label: "Change Reviewer(s)", type: "person" },
        ]},
        { title: "Time Tracking", fields: [
          { k: "estimate", label: "Original estimate", type: "duration", placeholder: "e.g. 2w 3d 4h" },
        ]},
      ],
      worklog: true,
      workflow: {
        start: "Draft",
        states: {
          "Draft": { cat: "todo", next: ["Awaiting Approval", "On Hold", "Cancelled"] },
          "Awaiting Approval": { cat: "wait", next: ["Approved", "Draft", "On Hold", "Cancelled"] },
          "Approved": { cat: "prog", next: ["In Development", "On Hold", "Cancelled"] },
          "In Development": { cat: "prog", next: ["Testing", "On Hold", "Approved"] },
          "Testing": { cat: "prog", next: ["Done", "In Development", "On Hold"] },
          "On Hold": { cat: "wait", next: ["Draft", "Awaiting Approval", "Approved", "In Development", "Testing", "Cancelled"] },
          "Done": { cat: "done", next: ["Testing"] },
          "Cancelled": { cat: "bad", next: ["Draft"] },
          // older name for In Development / Testing
          "Implementing": { cat: "prog", next: ["In Development", "Testing", "Done"] },
        },
      },
    },

    bridge: {
      label: "Bridge / Bypass",
      short: "Bridge/Bypass",
      sections: [
        { title: "Details", fields: [
          { k: "component", label: "Component", type: "text", list: COMPONENTS, req: true },
          { k: "department", label: "Department", type: "text", list: DEPARTMENTS, req: true },
          { k: "equipment", label: "Equipment Number", type: "text", req: true, placeholder: "e.g. CVR102 BRK001" },
        ]},
        { title: "Bridge / Bypass", fields: [
          { k: "reason", label: "Reason", type: "textarea", req: true, wide: true, rows: 4 },
          { k: "bypassType", label: "Bypass Type", type: "select", req: true,
            opts: ["Interlock Bypass", "Hard-wired Bridge", "Forced I/O", "Alarm Inhibit / Suppression", "Protection Function Bypass", "Setpoint / Timer Change", "Other"] },
          { k: "multiple", label: "Multiple Bridge/Bypass?", type: "yesno", req: true },
          { k: "multipleRefs", label: "Related bridge/bypass tickets", type: "text", showIf: { k: "multiple", v: "Yes" }, req: true, placeholder: "e.g. WB-0012, WB-0013" },
          { k: "details", label: "Details", type: "textarea", req: true, wide: true, rows: 4, help: "Exactly what is bridged/bypassed and how (tag, terminal, logic)." },
        ]},
        { title: "Risk Assessment", fields: [
          { k: "riskMatrixLink", label: "Risk Matrix Link", type: "url" },
          { k: "procedureLink", label: "Procedure Link", type: "url" },
        ].concat(riskFields("Residual Risk Rating")) },
        { title: "People", fields: [
          { k: "assignee", label: "Assignee", type: "person", placeholder: "e.g. Inload/Outload Superintendent" },
          { k: "reporter", label: "Reporter", type: "person", me: true },
          { k: "requestedBy", label: "Application Requested By", type: "person", req: true, me: true },
          { k: "maintSupervisor", label: "Maintenance Supervisor", type: "person", req: true },
          { k: "prodSupervisor", label: "Production Supervisor", type: "person", req: true },
        ]},
        { title: "Dates", fields: [
          { k: "maintApprovedAt", label: "Maintenance Supervisor Approved", type: "datetime" },
          { k: "prodApprovedAt", label: "Production Supervisor Approved", type: "datetime" },
          { k: "appliedAt", label: "Applied Date/Time", type: "datetime" },
          { k: "expiryAt", label: "Expiry Date/Time", type: "datetime", req: true },
          { k: "removedAt", label: "Removed Date/Time", type: "datetime" },
        ]},
      ],
      workflow: {
        start: "Requested",
        states: {
          "Requested": { cat: "todo", next: ["Approved", "Cancelled"] },
          "Approved": { cat: "wait", next: ["Applied", "Cancelled"] },
          "Applied": { cat: "prog", next: ["Removed"] },
          "Expired": { cat: "bad", next: ["Removed", "Applied"] },
          "Removed": { cat: "done", next: [] },
          "Cancelled": { cat: "bad", next: ["Requested"] },
        },
        // Moving to these states stamps the date field if it is empty.
        stamps: { "Applied": "appliedAt", "Removed": "removedAt" },
        // Moving to these states needs these fields filled first.
        gates: { "Approved": ["maintApprovedAt", "prodApprovedAt"], "Applied": ["expiryAt"] },
      },
    },

    service: {
      label: "Service Request",
      short: "Service",
      sections: [
        { title: "Details", fields: [
          { k: "component", label: "Component", type: "text", list: COMPONENTS, req: true },
          { k: "requestType", label: "Request Type", type: "select", req: true, def: "Call",
            opts: ["Call", "Email", "Teams", "Walk-up", "Call-out", "Remote Support"] },
          { k: "department", label: "Department", type: "text", list: DEPARTMENTS, req: true },
        ]},
        { title: "Description", fields: [
          { k: "userFullName", label: "User Full Name", type: "person", req: true, help: "Who raised the request" },
          { k: "equipment", label: "Equipment/System", type: "text", req: true, placeholder: "e.g. FDR531" },
          { k: "issue", label: "Description of Issue", type: "textarea", req: true, wide: true, rows: 4 },
          { k: "resolution", label: "Description of Resolution", type: "textarea", wide: true, rows: 5, reqAt: ["Done"] },
          { k: "followUp", label: "Follow Up Required", type: "yesno", reqAt: ["Done"] },
          { k: "followUpNote", label: "Follow-up details", type: "text", showIf: { k: "followUp", v: "Yes" }, placeholder: "e.g. If problem comes up again" },
        ]},
        { title: "People", fields: [
          { k: "assignee", label: "Assignee", type: "person", me: true },
          { k: "reporter", label: "Reporter", type: "person", me: true },
        ]},
      ],
      workflow: {
        start: "Open",
        states: {
          "Open": { cat: "todo", next: ["In Progress", "Done"] },
          "In Progress": { cat: "prog", next: ["Done", "Open"] },
          "Done": { cat: "done", next: ["Open"] },
        },
      },
    },
  };

  window.WB_SCHEMA = { TYPES, LIKELIHOOD, SEVERITY, riskRank };
})();
