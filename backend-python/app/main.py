"""FastAPI application entrypoint for the Career Hub service (backend-python)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import get_settings
from app.routers import ai, companies, contact_imports, contacts, discover, email, sponsors


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="Advance Academy Career Hub API",
        version=__version__,
        description="Career Hub service: company and job search, the coach crawler, contacts, the sponsor register and outreach.",
    )

    # Allow the Vercel frontend origin(s) to call the API from the browser.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        # `or None` matters: an empty pattern would match every origin.
        allow_origin_regex=settings.allowed_origin_regex or None,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(ai.router)
    app.include_router(email.router)
    app.include_router(discover.router)
    app.include_router(companies.router)
    # Before contacts: /contacts/imports must not be read as /contacts/{contact_id}.
    app.include_router(contact_imports.router)
    app.include_router(contacts.router)
    app.include_router(sponsors.router)

    @app.get("/health", tags=["health"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
