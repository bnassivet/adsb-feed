"""The desktop fast path experiment: gates, veto, small executors, and the
service's own path, evaluated against the main agent.

Record: ``FAST_PATH_EXPERIMENT.md`` in this directory. The fast path itself is
``adsb_agent.fast_path``; these modules import its constants.

Shared evaluation code (datasets, MLflow setup, the main agent's first step)
stays in ``eval/``. Scripts here are run as files from ``rust/adsb-agent``, so
each puts ``eval/`` on the path before importing it; modules here import each
other as ``fastpath_agent.<module>``.
"""
