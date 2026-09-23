"""
THE FUTURES UNIVERSE IS YOUR JOURNAL, READ EXACTLY.

Asked for, verbatim (2026-09-23): "in the futures I need you from the excel file
we are using ... you need to give me only from that".

The desk's copy of that list, data/journal-symbols.json, was made once in July
and has 128 names. The workbook has 130: M&M and M&MFIN were lost, because the
ampersand did not survive whatever produced the copy -- and Mahindra & Mahindra
is one of the larger F&O names. This reads the NAME column of the SCREENER sheet
exactly, with nothing stripped but surrounding whitespace, and writes the list
back in the same shape.

Run it whenever the workbook changes:

    python scripts/import-journal-excel.py "C:/Users/kulde/Downloads/journal (1).xlsx"

Names in the workbook that no longer trade as futures on NSE are kept in the
file (they are still your list), and the build reports them as untradeable
rather than dropping them silently.
"""

import datetime
import json
import os
import sys

import openpyxl

SOURCE = sys.argv[1] if len(sys.argv) > 1 else r"C:/Users/kulde/Downloads/journal (1).xlsx"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "journal-symbols.json")

wb = openpyxl.load_workbook(SOURCE, read_only=True, data_only=True)
ws = wb["SCREENER"]
names = []
header_seen = False
for row in ws.iter_rows(values_only=True):
    cells = list(row) + [None] * 3
    attribute, name = cells[1], cells[2]
    if not header_seen:
        if str(name).strip().upper() == "NAME":
            header_seen = True
        continue
    if name is None or str(name).strip() == "":
        continue
    if str(attribute).strip().upper() != "NSEFUT":
        continue
    names.append(str(name).strip().upper())

unique = list(dict.fromkeys(names))  # the workbook's own order, first occurrence
modified = datetime.datetime.fromtimestamp(os.path.getmtime(SOURCE)).strftime("%Y-%m-%d")
payload = {
    "source": os.path.basename(SOURCE) + ", sheet SCREENER, column NAME, rows tagged NSEFUT",
    "capturedAt": datetime.date.today().isoformat(),
    "workbookModified": modified,
    "note": ("The futures universe: the static desk shows futures ONLY for these names "
             "(user instruction, 2026-09-23). A name that no longer trades as futures on "
             "NSE stays on this list and is reported as untradeable on the page."),
    "symbols": unique,
}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"{len(unique)} names from {os.path.basename(SOURCE)} (modified {modified}) -> data/journal-symbols.json")
