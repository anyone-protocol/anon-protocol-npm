# Migration Guide: Transitioning to the New Anon SDK Structure

## **Overview**
This document provides a structured migration plan for transitioning both the **Python** and **NPM** SDKs to a **unified, object-oriented structure** that follows the **Stem** design principles.

## **Motivation**
### **Key points**
- **Improved maintainability:** By mirroring Stem's structure, the SDK remains modular and easy to maintain.
- **Consistency across SDKs:** Both Python and NPM SDKs follow the same structure and design patterns, making it easier for developers to switch between them.
- **Enhanced readability & usability:** Object-oriented design ensures that data (e.g., circuit paths) is represented in a structured way rather than raw strings.
- **Better modularity:** New components such as `templates.py` and `starters.py` improve code reuse and simplify complex interactions with Anon.
- **Not reinventing a wheel:** Stem already has a comprehensive binary mangement and other battle-tested code we tried to implement from scratch. Example: `process.py` - for running Anon binary and listen to logs.

## **Naming convention**
To ensure consistency, we will use the following naming for our SDKs:
- **Python SDK:** `anon-python-sdk`
- **Node.js SDK:** `anon-node-sdk`

## **Key migration principles**
1. **Structure and naming consistency**  
   - **Both SDKs should migrate to the same structure as Stem.**  
   - **Python SDK** will wrap **Stem classes** with the **same names**.  
   - **NPM SDK** will implement stem logic from scratch but **follow the same structure**.

2. **Object-oriented design**  
   - Instead of handling **raw strings**, SDK classes should use **typed objects** (e.g., Circuit path should be a list of fingerprints, not a string).  
   - Encapsulation should be applied to provide a **clean, intuitive API**.

3. **New files & module naming**  
   - **`socks.py` / `socks.ts`** → Implements **SOCKS5 proxy handling** (since Tor/Stem lacks built-in SOCKS support).  
   - **`process.py` / `process.ts`** → Handles **running and managing the Anon binary**.  
   - **`templates.py` / `templates.ts`** → Contains **multi-request templates** for operations like **fetching relay information for a circuit**.  
   - **`starters.py` / `starters.ts`** → Manages **end-to-end scenarios**, such as **VPN-starter** etc.

---

## **New SDK structure**
### **Python SDK (`anon-python-sdk/`)**
```
anon-python-sdk/
│── anon_python_sdk/
│   ├── control.py     # Control port client implementation
│   ├── process.py     # Handles Anon binary execution
│   ├── socks.py       # SOCKS5 client implementation
│   ├── proxy.py       # Proxy management
│   ├── templates.py   # Multi-step request templates
│   ├── starters.py    # High-level starters (e2e scenarios)
│── tests/             # Unit tests
│── examples/          # Usage examples
│── setup.py           # Python package setup
│── README.md          # Documentation
```

### **NPM SDK (`anon-node-sdk/`)**
```
anon-node-sdk/
│── src/
│   ├── control.ts     # Control port client implementation
│   ├── process.ts     # Handles Anon binary execution
│   ├── socks.ts       # SOCKS5 client implementation
│   ├── proxy.ts       # Proxy management
│   ├── templates.ts   # Multi-step request templates
│   ├── starters.ts    # High-level starters (e2e scenarios)
│── tests/             # Unit tests
│── examples/          # Usage examples
│── package.json       # NPM package setup
│── README.md          # Documentation
```

---

## **Migration steps**
### **1. Python SDK migration**
- **Move class definitions to follow Stem structure** (`control.py`, `process.py`, etc.).
- **Replace direct Stem calls with wrapped classes**.
- **Migrate `socks_client.py` to `socks.py` for SOCKS handling**.
- **Migrate `anon_runner.py` to `process.py` for binary execution**.

### **2. NPM SDK Migration**
- **Follow the same structure as Python SDK.**
- **Migrate from `anon-{protocol}-client.ts` structure to `{protocol}.ts` for ControlPort, SOCKS, and binary management.**
- **Ensure an object-oriented API for better usability.**

---

## **Final notes**
💡 **Following Stem’s structure ensures maintainability and modularity.**  
💡 **Python SDK will serve as a thin wrapper over Stem.**  
💡 **NPM SDK requires a full implementation of the logic.**  
💡 **Anon runner logic is already implemented in Stem, no need to implement from scratch**  
💡 **Templates and starters help simplify multi-step API interactions.**

