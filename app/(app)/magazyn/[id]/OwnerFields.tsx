"use client";

import { useState } from "react";

/** Właściciel i komisant razem: wybór komisanta = komis, „własna” = bez komisanta. */
export function OwnerFields({ ownerType, consignorId, consignors }: { ownerType: string; consignorId: string | null; consignors: { id: string; name: string }[] }) {
  const [owner, setOwner] = useState(ownerType);
  const [consignor, setConsignor] = useState(consignorId ?? "");
  return (
    <>
      <div>
        <label className="label" htmlFor="owner_type">Właściciel</label>
        <select className="input" id="owner_type" name="owner_type" value={owner}
          onChange={(e) => { setOwner(e.target.value); if (e.target.value === "own") setConsignor(""); }}>
          <option value="own">własna</option>
          <option value="consignment">komis</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="consignor_id">Komisant (dla komisu)</label>
        <select className="input" id="consignor_id" name="consignor_id" value={consignor} required={owner === "consignment"}
          onChange={(e) => { setConsignor(e.target.value); if (e.target.value) setOwner("consignment"); }}>
          <option value="">–</option>
          {consignors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
    </>
  );
}
