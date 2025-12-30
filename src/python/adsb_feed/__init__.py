"""ADS-B Feed Client - Forward dump1090 messages to Apache Pulsar"""

__version__ = "0.1.0"

from .client import ADSBFeedClient, main

__all__ = ["ADSBFeedClient", "main", "__version__"]
