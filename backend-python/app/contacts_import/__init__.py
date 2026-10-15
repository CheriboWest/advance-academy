"""Bulk company/contact import wizard (/coach/contacts/import).

upload.py reads an .xlsx/.csv into raw rows; mapping.py turns them into
company/contact candidates using the cleaning rules in clean.py and rows.py.
Matching and the import itself are SQL (migration 049); the routes are
app/routers/contact_imports.py. See CLAUDE.md in this folder.
"""
