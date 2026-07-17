"""Module manifest — the loader reads the lowercase `manifest` symbol from here.

Convention (app/core/module_loader.py:171-235):
  * directory name == manifest.name with the "oe_" prefix stripped
      -> name "oe_achi"  ==>  app/modules/achi/
  * router.py exporting `router` is auto-mounted at /api/v1/achi/
  * models.py is auto-imported before create_all (app/main.py:2503)

category is deliberately NOT "core": core modules are hard-blocked from being
disabled (module_loader.py:421-422). Ours must stay switchable.
"""

from app.core.module_loader import ModuleManifest

manifest = ModuleManifest(
    name="oe_achi",
    version="0.1.0",
    display_name="ACHI Scaffolding",
    description="Company-specific extensions for Achi Scaffolding.",
    author="Achi Scaffolding",
    category="community",
    depends=[],
    optional_depends=["oe_takeoff", "oe_crm"],
    auto_install=False,
    enabled=True,
)
