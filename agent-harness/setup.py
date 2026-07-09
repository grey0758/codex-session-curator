from setuptools import find_namespace_packages, setup


setup(
    name="cli-anything-codex-session-curator",
    version="0.1.0",
    description="CLI-Anything harness for Codex Session Curator",
    packages=find_namespace_packages(include=["cli_anything.*"]),
    install_requires=["click>=8.0"],
    python_requires=">=3.9",
    entry_points={
        "console_scripts": [
            "cli-anything-codex-session-curator=cli_anything.codex_session_curator._cli:main",
        ],
    },
)
